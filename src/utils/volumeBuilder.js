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
 * Reduces a set of slices to one stack of distinct positions.
 *
 * A single series can contain several acquisitions covering the same anatomy - a pre/post contrast
 * pair is the common case - and DICOM gives them the same SeriesInstanceUID. Stacked together they
 * make a volume with twice the slices and none of the height: 501 slices at 2.5 mm reads as 1252 mm
 * of patient where the positions only span 707 mm, so the body comes out stretched, with the two
 * acquisitions interleaved slice by slice through the overlap.
 *
 * Does nothing at all unless two slices genuinely share a position, so ordinary single-acquisition
 * series are untouched.
 */
function selectOneStack(slices, notes) {
    const positionKey = s => s.position.map(v => v.toFixed(3)).join(',');

    const distinct = new Set(slices.map(positionKey));
    if (distinct.size === slices.length)
        return slices;

    const note = `${slices.length} slices occupy only ${distinct.size} distinct positions - ` +
        'this series holds more than one acquisition';
    console.warn(note);
    notes.push({ phase: 'volume build', message: note });

    // Prefer the acquisition with the most slices, and on a tie the one spanning the most anatomy.
    const byAcquisition = new Map();
    for (const slice of slices) {
        if (!byAcquisition.has(slice.acquisition)) byAcquisition.set(slice.acquisition, []);
        byAcquisition.get(slice.acquisition).push(slice);
    }

    const span = group => {
        const zs = group.map(s => s.zPosition);
        return Math.max(...zs) - Math.min(...zs);
    };

    const candidates = [...byAcquisition.entries()]
        .sort((a, b) => b[1].length - a[1].length || span(b[1]) - span(a[1]));

    for (const [acquisition, group] of candidates) {
        console.log(`  acquisition ${acquisition || '(unnumbered)'}: ${group.length} slices, ` +
            `${span(group).toFixed(1)} mm span`);
    }

    let chosen = candidates[0][1];
    if (candidates.length > 1) {
        const chose = `Using acquisition ${candidates[0][0] || '(unnumbered)'} ` +
            `(${chosen.length} slices, ${span(chosen).toFixed(1)} mm) and ignoring ` +
            `${slices.length - chosen.length} slices from the other ${candidates.length - 1}. ` +
            'Every slice still gets its own JPG; only the volume is built from one acquisition.';
        console.warn(chose);
        notes.push({ phase: 'volume build', message: chose });
    }

    // Belt and braces: if positions still collide - a series with genuinely duplicated files, or no
    // AcquisitionNumber to separate them by - keep the first at each position.
    const seen = new Set();
    const unique = [];
    for (const slice of chosen) {
        const key = positionKey(slice);
        if (seen.has(key)) continue;
        seen.add(key);
        unique.push(slice);
    }

    if (unique.length !== chosen.length) {
        const dropped = `Dropped ${chosen.length - unique.length} further slices sharing a position`;
        console.warn(dropped);
        notes.push({ phase: 'volume build', message: dropped });
    }

    return unique;
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
    // Reassigned once the metadata pass is done: overlapping acquisitions are filtered out.
    let slices = [];

    // Non-fatal problems worth telling the user about: skipped files, blanked slices, a second
    // acquisition being ignored. These used to reach only the server console, so an upload could
    // quietly drop half its input and still report success.
    const notes = [];

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
            // Not every thrown value carries a message - dicom-parser can reject a file with one
            // that is undefined, which produced the useless note "could not be parsed: undefined".
            const reason = e?.message || (typeof e === 'string' ? e : e?.name) || 'no reason given';
            console.warn(`Skipping unparseable DICOM: ${path.basename(filePath)}: ${reason}`);
            notes.push({ phase: 'volume build', file: path.basename(filePath),
                message: 'Skipped - could not be parsed as DICOM: ' + reason });
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

        // Not every valid DICOM file is an image. A DICOMDIR, a structured report or a presentation
        // state parses happily but has no Rows/Columns, and stacking one as a slice would poison the
        // volume's dimensions - especially if it sorted first.
        if (!rows || !columns) {
            console.warn(`Skipping non-image DICOM (no Rows/Columns): ${path.basename(filePath)}`);
            notes.push({ phase: 'volume build', file: path.basename(filePath),
                message: 'Skipped - valid DICOM but carries no image (no Rows/Columns), such as a DICOMDIR' });
            buf = null;
            dataSet = null;
            continue;
        }

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
            windowWidth,
            // (0020,0012) AcquisitionNumber. One series can hold several acquisitions covering the
            // same anatomy - a pre/post contrast pair, for instance - and they must not be stacked
            // into one volume.
            acquisition: dataSet.string('x00200012') || '',
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

    slices = selectOneStack(slices, notes);
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

    // Gathered while every voxel is being touched anyway, and used afterwards to decide whether the
    // outputs can be int16 instead of float32. Measuring beats predicting from the header: a series
    // can carry a fractional slope, and 16-bit unsigned stored values can exceed int16 once the
    // intercept is applied.
    let min = Infinity;
    let max = -Infinity;
    let allIntegral = true;

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
                notes.push({ phase: 'volume build', file: path.basename(slice.filePath),
                    message: `Slice ${z} written as blank - pixel data could not be extracted: ${e.message}` });
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

            // Only needed when the pixel data is short of a full slice: otherwise the loop below
            // overwrites every element anyway, and this was 262,144 dead writes per slice.
            if (count < sliceSize)
                sliceFloat.fill(0);

            if (slope === 1 && intercept === 0) {
                for (let i = 0; i < count; i++) {
                    const value = pixelData[i];
                    sliceFloat[i] = value;
                    if (value < min) min = value;
                    if (value > max) max = value;
                }
            } else {
                for (let i = 0; i < count; i++) {
                    const value = pixelData[i] * slope + intercept;
                    sliceFloat[i] = value;
                    if (value < min) min = value;
                    if (value > max) max = value;
                    // (v|0) !== v catches fractions and NaN, and anything beyond +/-2^31 - which
                    // fails the range test anyway. A fractional RescaleSlope (PET, SUV-scaled MR)
                    // clears this on the first voxel and the outputs stay float32.
                    if ((value | 0) !== value) allIntegral = false;
                }
            }

            // The padding written for a slice whose pixel data could not be read, and any unfilled
            // tail, are zeros - so they widen the range but never break integrality.
            if (count < sliceSize) {
                if (min > 0) min = 0;
                if (max < 0) max = 0;
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

    if (!Number.isFinite(min)) { min = 0; max = 0; }
    const stats = { min, max, allIntegral };
    console.log(`Volume values: ${min}..${max}, ${allIntegral ? 'all integral' : 'non-integral present'}`);

    return {
        tempFilePath,
        dimensions: { rows, columns, depth },
        spacing,
        origin,
        window,
        stats,
        notes,
        cleanup() {
            try { fs.unlinkSync(tempFilePath); } catch {}
        }
    };
}

// The volume payload is written to output files by src/utils/volumeStream.js, which also narrows
// float32 to int16 on the way out. It replaced a byte-copying appendVolumeToFile that lived here.
