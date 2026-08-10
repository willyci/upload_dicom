import fs from 'fs';
import os from 'os';
import path from 'path';
import dicomParser from 'dicom-parser';
import { DicomMetaDictionary, DicomMessage } from './dicomHelpers.js';
import { extractPixelData, yieldToEventLoop } from './pixelData.js';

/** Optional manual GC — only works with --expose-gc flag */
const gc = typeof global.gc === 'function' ? global.gc : null;

function logMemory(label) {
    const mem = process.memoryUsage();
    console.log(`[MEM ${label}] RSS: ${Math.round(mem.rss / 1024 / 1024)} MB | Heap: ${Math.round(mem.heapUsed / 1024 / 1024)}/${Math.round(mem.heapTotal / 1024 / 1024)} MB`);
}

/**
 * First value of a DICOM element that may arrive as a number, a string, or a multi-valued array.
 * WindowCenter in particular is often "40\40" or [40, 40].
 */
function firstNumber(value, fallback) {
    if (Array.isArray(value)) value = value[0];
    if (typeof value === 'string') value = Number(value.split('\\')[0]);
    return Number.isFinite(value) ? Number(value) : fallback;
}

/**
 * Distance between neighbouring slices, taken from ImagePositionPatient rather than
 * SliceThickness: thickness is how much tissue each slice covers, which is not the same as the
 * step between them whenever the series has a gap or overlap, and it is the step that decides
 * the volume's geometry.
 *
 * Uses the median of the gaps so one duplicated or missing slice cannot skew the result, and
 * falls back to SliceThickness when the positions are unusable.
 */
function computeSliceSpacing(sortedSlices, fallback) {
    if (sortedSlices.length < 2) return fallback;

    const gaps = [];
    for (let i = 1; i < sortedSlices.length; i++) {
        const a = sortedSlices[i - 1].position;
        const b = sortedSlices[i].position;
        const gap = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
        if (gap > 0.0001) gaps.push(gap);
    }

    if (gaps.length === 0) return fallback;

    gaps.sort((a, b) => a - b);
    const median = gaps[Math.floor(gaps.length / 2)];
    return Number.isFinite(median) && median > 0.0001 ? median : fallback;
}

/**
 * Build volume data from DICOM files and write to a temp file on disk.
 * Only one slice (~1 MB) is held in memory at a time.
 *
 * @param {string[]} dicomFiles - array of file paths
 * @param {Function} [onSliceParsed] - optional async callback(filePath, rawBuffer, dcmjsDataset)
 *   called for each slice DURING the second pass so the caller can reuse the parsed data
 *   (e.g. for JPG/bump conversion) without re-reading/re-parsing the file.
 * @returns {{ tempFilePath, dimensions, spacing, origin, cleanup() }}
 */
export async function buildVolumeData(dicomFiles, onSliceParsed) {
    const slices = [];

    logMemory('volume-start');

    // First pass: collect metadata using lightweight dicom-parser (NOT dcmjs).
    // dicom-parser references into the raw buffer and does NOT decode pixel data
    // into separate JS objects, so it uses much less memory than dcmjs.
    for (let i = 0; i < dicomFiles.length; i++) {
        const filePath = dicomFiles[i];
        let buf = fs.readFileSync(filePath);
        let dataSet;
        try {
            dataSet = dicomParser.parseDicom(buf);
        } catch (e) {
            console.warn(`Skipping unparseable DICOM: ${path.basename(filePath)}: ${e.message}`);
            buf = null;
            continue;
        }

        // ImagePositionPatient (0020,0032)
        const ippStr = dataSet.string('x00200032');
        const position = ippStr ? ippStr.split('\\').map(Number) : [0, 0, 0];

        // PixelSpacing (0028,0030)
        const psStr = dataSet.string('x00280030');
        const spacing = psStr ? psStr.split('\\').map(Number) : [1, 1];

        // SliceThickness (0018,0050)
        const stStr = dataSet.string('x00180050');
        const sliceThickness = stStr ? Number(stStr) : 1;

        const rows = dataSet.uint16('x00280010');
        const columns = dataSet.uint16('x00280011');

        // WindowCenter (0028,1050) / WindowWidth (0028,1051): the radiologist's own greyscale
        // window, in rescaled units. Kept here so the derived images can use it instead of
        // guessing a window from the data's extremes.
        const windowCenter = firstNumber(dataSet.string('x00281050'), null);
        const windowWidth = firstNumber(dataSet.string('x00281051'), null);

        slices.push({
            filePath,
            position,
            spacing: [...spacing, sliceThickness],
            rows,
            columns,
            zPosition: position[2],
            windowCenter,
            windowWidth
        });

        // Release references so GC can reclaim the buffer
        buf = null;
        dataSet = null;

        if (i % 50 === 0) {
            if (gc) gc();
            await yieldToEventLoop();
        }
    }

    if (gc) gc();
    logMemory('volume-metadata-done');

    if (slices.length === 0) {
        throw new Error('No DICOM files found');
    }

    slices.sort((a, b) => a.zPosition - b.zPosition);

    const rows = slices[0].rows;
    const columns = slices[0].columns;
    const depth = slices.length;
    const spacing = slices[0].spacing;
    const origin = slices[0].position;

    // spacing is slices[0].spacing by reference, so keep the declared thickness before overwriting.
    const sliceThickness = spacing[2];
    spacing[2] = computeSliceSpacing(slices, sliceThickness);
    console.log(`Volume: ${columns}x${rows}x${depth}, spacing [${spacing.join(', ')}] ` +
        `(z measured from slice positions; SliceThickness was ${sliceThickness})`);

    // The middle slice's window is the most representative of the series, and avoids a scout or
    // localiser image at either end setting it.
    const middle = slices[Math.floor(slices.length / 2)];
    const window = middle.windowWidth > 0
        ? { center: middle.windowCenter, width: middle.windowWidth }
        : null;

    // Second pass: write pixel data to temp file, one slice at a time
    const tempFilePath = path.join(os.tmpdir(), `dicom_vol_${Date.now()}_${process.pid}.raw`);
    const fd = fs.openSync(tempFilePath, 'w');

    try {
        const sliceSize = rows * columns;
        const sliceFloat = new Float32Array(sliceSize);

        for (let z = 0; z < depth; z++) {
            const slice = slices[z];

            let dicomFileBuffer = fs.readFileSync(slice.filePath);
            let dicomData = DicomMessage.readFile(dicomFileBuffer.buffer);
            let dataset = DicomMetaDictionary.naturalizeDataset(dicomData.dict);

            let pixelData;
            try {
                pixelData = extractPixelData(dataset);
            } catch (e) {
                console.warn(`Failed to extract pixel data for slice ${z}:`, e.message);
                sliceFloat.fill(0);
                fs.writeSync(fd, Buffer.from(sliceFloat.buffer, sliceFloat.byteOffset, sliceFloat.byteLength));
                // Still let caller do JPG/bump even if pixel extraction failed for volume
                if (onSliceParsed) {
                    await onSliceParsed(slice.filePath, dicomFileBuffer, dataset);
                }
                // Release references
                dicomFileBuffer = null;
                dicomData = null;
                dataset = null;
                if (z % 10 === 0) {
                    if (gc) gc();
                    await yieldToEventLoop();
                }
                continue;
            }

            // Apply RescaleSlope/RescaleIntercept, as jpg.js already does. Without it the volume
            // holds raw stored values rather than Hounsfield units - for CT that is typically a
            // +1024 offset, which puts air at 0 instead of -1000 and quietly breaks everything
            // downstream that reasons in HU: the STL bone threshold, and the viewers' presets.
            // Read per slice, because slope and intercept may legitimately differ between them.
            const slope = firstNumber(dataset.RescaleSlope, 1);
            const intercept = firstNumber(dataset.RescaleIntercept, 0);
            const count = Math.min(pixelData.length, sliceSize);

            sliceFloat.fill(0);
            if (slope === 1 && intercept === 0) {
                for (let i = 0; i < count; i++) {
                    sliceFloat[i] = pixelData[i];
                }
            } else {
                for (let i = 0; i < count; i++) {
                    sliceFloat[i] = pixelData[i] * slope + intercept;
                }
            }

            if (z === 0) {
                console.log(`Rescale: slope=${slope} intercept=${intercept} ` +
                    `(values are ${slope === 1 && intercept === 0 ? 'stored values' : 'rescaled units / HU'})`);
            }

            fs.writeSync(fd, Buffer.from(sliceFloat.buffer, sliceFloat.byteOffset, sliceFloat.byteLength));

            // Let caller reuse the parsed data (e.g. for JPG/bump) before we release it
            if (onSliceParsed) {
                await onSliceParsed(slice.filePath, dicomFileBuffer, dataset);
            }

            // Explicitly release heavy objects so GC can reclaim them
            dicomFileBuffer = null;
            dicomData = null;
            dataset = null;
            pixelData = null;

            if (z % 10 === 0) {
                if (gc) gc();
                await yieldToEventLoop();
            }
        }
    } finally {
        fs.closeSync(fd);
    }

    if (gc) gc();
    logMemory('volume-build-done');

    return {
        tempFilePath,
        dimensions: { rows, columns, depth },
        spacing,
        origin,
        window,
        cleanup() {
            try { fs.unlinkSync(tempFilePath); } catch {}
        }
    };
}

/**
 * Stream-copy volume data from temp file to output file (append mode).
 * Uses a fixed 4 MB buffer — never loads the full volume into memory.
 */
export function appendVolumeToFile(tempFilePath, outputPath) {
    const CHUNK = 4 * 1024 * 1024;
    const buf = Buffer.alloc(CHUNK);
    const srcFd = fs.openSync(tempFilePath, 'r');
    const dstFd = fs.openSync(outputPath, 'a');
    try {
        let position = 0;
        let bytesRead;
        while ((bytesRead = fs.readSync(srcFd, buf, 0, CHUNK, position)) > 0) {
            fs.writeSync(dstFd, buf, 0, bytesRead);
            position += bytesRead;
        }
    } finally {
        fs.closeSync(srcFd);
        fs.closeSync(dstFd);
    }
}
