import fs from 'fs';
import path from 'path';
import { createCanvas } from 'canvas';
import { yieldToEventLoop } from '../utils/pixelData.js';
import { setProcessingStatus } from '../utils/progress.js';

const gc = typeof global.gc === 'function' ? global.gc : null;

function logMemory(label) {
    const mem = process.memoryUsage();
    console.log(`[MEM ${label}] RSS: ${Math.round(mem.rss / 1024 / 1024)} MB | Heap: ${Math.round(mem.heapUsed / 1024 / 1024)}/${Math.round(mem.heapTotal / 1024 / 1024)} MB`);
}

/**
 * Read one z-slice from the volume temp file into a Float32Array.
 */
function loadSlice(srcFd, readBuf, z, target, sliceSize) {
    const sliceBytes = sliceSize * 4;
    fs.readSync(srcFd, readBuf, 0, sliceBytes, z * sliceBytes);
    const view = new Float32Array(readBuf.buffer, readBuf.byteOffset, sliceSize);
    target.set(view);
}

/** Up to five evenly spread slice indices, used for sampling the data's distribution. */
function sampleIndices(depth) {
    const indices = [];
    const step = Math.max(1, Math.floor(depth / 5));
    for (let i = 0; i < depth; i += step) {
        indices.push(i);
    }
    if (indices.length > 5) indices.length = 5;
    return indices;
}

/**
 * Scan a few sample z-slices and window on the 1st-99th percentile rather than the absolute
 * min/max. A single hot voxel - a metal implant, a marker, noise - used to stretch the window
 * over the whole range and leave the anatomy squeezed into the bottom third of the greyscale.
 *
 * One pass over the samples: the value range comes from volume.stats, which was gathered while the
 * temp file was written, so the bounds no longer need a pass of their own.
 */
function computeWindow(volume, srcFd, readBuf, sliceSize, depth) {
    const indices = sampleIndices(depth);
    const sliceFloat = new Float32Array(sliceSize);
    const { min, max } = volume.stats;

    if (!(max > min)) {
        return { windowCenter: min, windowWidth: 1 };
    }

    const BINS = 2048;
    const histogram = new Int32Array(BINS);
    const scale = (BINS - 1) / (max - min);
    let total = 0;

    for (const z of indices) {
        loadSlice(srcFd, readBuf, z, sliceFloat, sliceSize);
        for (let i = 0; i < sliceSize; i++) {
            histogram[Math.round((sliceFloat[i] - min) * scale)]++;
            total++;
        }
    }

    const lowTarget = total * 0.01;
    const highTarget = total * 0.99;
    let running = 0, lowBin = 0, highBin = BINS - 1;

    for (let bin = 0; bin < BINS; bin++) {
        running += histogram[bin];
        if (running <= lowTarget) lowBin = bin;
        if (running >= highTarget) { highBin = bin; break; }
    }

    const low = min + lowBin / scale;
    const high = min + highBin / scale;
    const windowWidth = Math.max(high - low, 1);

    return { windowCenter: low + windowWidth / 2, windowWidth };
}

/**
 * The window to render the slices with. The DICOM's own WindowCenter/WindowWidth is what the
 * scanner or the reporting radiologist chose, so it beats anything derived from the pixels -
 * for a head CT that is typically 40/350, against a data range of some 4000, which is the
 * difference between readable soft tissue and uniform grey.
 */
function resolveWindow(volume, srcFd, readBuf, sliceSize, depth) {
    const declared = volume.window;
    if (declared && Number.isFinite(declared.center) && declared.width > 0) {
        console.log(`MPR window from DICOM: center=${declared.center}, width=${declared.width}`);
        return { windowCenter: declared.center, windowWidth: declared.width, windowSource: 'dicom' };
    }

    const { windowCenter, windowWidth } = computeWindow(volume, srcFd, readBuf, sliceSize, depth);
    console.log(`MPR window from data (1-99 percentile): center=${windowCenter.toFixed(1)}, width=${windowWidth.toFixed(1)}`);
    return { windowCenter, windowWidth, windowSource: 'percentile' };
}

/**
 * Apply windowing to a raw float value -> 0-255 uint8.
 */
function applyWindow(value, windowLow, windowHigh, windowWidth) {
    if (value <= windowLow) return 0;
    if (value >= windowHigh) return 255;
    return Math.round(((value - windowLow) / windowWidth) * 255);
}

/**
 * Zero-pad a number to 3 digits.
 */
function pad3(n) {
    return String(n).padStart(3, '0');
}

/**
 * Write a grayscale Uint8 buffer as a JPG using the provided canvas.
 */
/**
 * Assigning canvas.width or .height reallocates and clears the Cairo surface, so only do it when the
 * size actually changes - consecutive slices of one plane all share dimensions.
 */
function resizeCanvas(canvas, width, height) {
    if (canvas.width !== width) canvas.width = width;
    if (canvas.height !== height) canvas.height = height;
}

function writeJpg(canvas, ctx, data, width, height, outputPath) {
    resizeCanvas(canvas, width, height);
    const imageData = ctx.createImageData(width, height);
    let pixelIndex = 0;
    for (let i = 0; i < width * height; i++) {
        const v = data[i];
        imageData.data[pixelIndex++] = v;
        imageData.data[pixelIndex++] = v;
        imageData.data[pixelIndex++] = v;
        imageData.data[pixelIndex++] = 255;
    }
    ctx.putImageData(imageData, 0, 0);
    const buffer = canvas.toBuffer('image/jpeg', { quality: 0.85 });
    fs.writeFileSync(outputPath, buffer);
}

/**
 * Bump map from a greyscale Uint8 slice: x gradient, normalised to the full 0-255 range.
 *
 * The gradient and its range are computed in one pass over a plain typed array. This used to write
 * the whole RGBA surface into Cairo, read all of it back out with getImageData to find a min and a
 * max, rewrite it and put it back - about 3 MB of native copying per image, for two numbers the
 * gradient loop already had.
 */
function writeBumpJpg(canvas, ctx, data, width, height, outputPath) {
    const gradient = new Uint8Array(width * height);

    for (let y = 1; y < height - 1; y++) {
        const row = y * width;
        for (let x = 1; x < width - 1; x++) {
            const idx = row + x;
            const gx = data[idx + 1] - data[idx - 1];

            // As before, only the x gradient survives: the old code also computed a y gradient into
            // the green channel, then overwrote it during normalisation.
            let value = Math.floor(((gx / 255) + 1) * 127.5);
            if (value < 0) value = 0; else if (value > 255) value = 255;

            gradient[idx] = value;
        }
    }

    // Over the whole buffer, border included. The border is never written, so it contributes zeros
    // and pins the minimum at 0 - which is what the old getImageData scan did, and skipping it
    // stretched the contrast and made these files ~10% larger.
    let min = 255, max = 0;
    for (let i = 0; i < gradient.length; i++) {
        const v = gradient[i];
        if (v < min) min = v;
        if (v > max) max = v;
    }

    resizeCanvas(canvas, width, height);
    const imageData = ctx.createImageData(width, height);
    const scale = max > min ? 255 / (max - min) : 0;

    // Interior only, exactly as before. createImageData zeroes the buffer, so the one-pixel border
    // stays fully transparent and flattens to black when the JPEG is written - the old code left it
    // that way too, and filling it instead put a blue frame around every image.
    for (let y = 1; y < height - 1; y++) {
        const row = y * width;
        for (let x = 1; x < width - 1; x++) {
            const i = row + x;
            const normalized = scale > 0 ? Math.round((gradient[i] - min) * scale) : gradient[i];
            const out = i * 4;
            imageData.data[out] = normalized;
            imageData.data[out + 1] = normalized;
            imageData.data[out + 2] = 255;
            imageData.data[out + 3] = 255;
        }
    }

    ctx.putImageData(imageData, 0, 0);

    const buffer = canvas.toBuffer('image/jpeg', { quality: 0.85 });
    fs.writeFileSync(outputPath, buffer);
}

/**
 * Generate MPR (Multi-Planar Reconstruction) slices from a volume.
 *
 * Produces axial, sagittal, and coronal JPG images.
 * Single-pass scatter approach: reads each z-slice once,
 * writes axial JPG immediately, scatters windowed values
 * into sagittal and coronal buffers, then renders those.
 *
 * @param {Object} volume - { tempFilePath, dimensions: { rows, columns, depth }, spacing, origin }
 * @param {string} outputDir - directory to write mpr/ subdirectory into
 */
export async function convertToMpr(volume, outputDir) {
    console.log('Generating MPR slices...');
    logMemory('mpr-start');

    const { tempFilePath, dimensions, spacing } = volume;
    const { rows, columns, depth } = dimensions;
    const sliceSize = rows * columns;

    // Create output directories
    const mprDir = path.join(outputDir, 'mpr');
    const axialDir = path.join(mprDir, 'axial');
    const sagittalDir = path.join(mprDir, 'sagittal');
    const coronalDir = path.join(mprDir, 'coronal');
    const axialBumpDir = path.join(mprDir, 'axial_bump');
    const sagittalBumpDir = path.join(mprDir, 'sagittal_bump');
    const coronalBumpDir = path.join(mprDir, 'coronal_bump');

    fs.mkdirSync(axialDir, { recursive: true });
    fs.mkdirSync(sagittalDir, { recursive: true });
    fs.mkdirSync(coronalDir, { recursive: true });
    fs.mkdirSync(axialBumpDir, { recursive: true });
    fs.mkdirSync(sagittalBumpDir, { recursive: true });
    fs.mkdirSync(coronalBumpDir, { recursive: true });

    const sliceBytes = sliceSize * 4;
    const readBuf = Buffer.alloc(sliceBytes);
    const sliceFloat = new Float32Array(sliceSize);

    // Open temp file for reading
    const srcFd = fs.openSync(tempFilePath, 'r');

    let windowCenter, windowWidth, windowSource;
    try {
        // Step 2: Window from the DICOM header, or from the data's percentiles if it has none
        ({ windowCenter, windowWidth, windowSource } = resolveWindow(volume, srcFd, readBuf, sliceSize, depth));
    } catch (err) {
        fs.closeSync(srcFd);
        throw err;
    }

    const windowLow = windowCenter - windowWidth / 2;
    const windowHigh = windowCenter + windowWidth / 2;

    // Step 3: Allocate scatter buffers for sagittal and coronal
    // Sagittal (YZ plane, fixed X): each image is depth(W) x rows(H), one per column
    // sagittalAll[x * (depth * rows) + y * depth + z] = windowed value
    // Note the image runs left-to-right along +z; it is NOT reversed. Consumers have to orient
    // themselves to match, or the slice comes out mirrored.
    let sagittalAll = new Uint8Array(columns * depth * rows);

    // Coronal (XZ plane, fixed Y): each image is columns(W) x depth(H), one per row
    // coronalAll[y * (columns * depth) + z * columns + x] = windowed value
    let coronalAll = new Uint8Array(rows * columns * depth);

    logMemory('mpr-buffers-allocated');

    // Create a single reusable canvas
    const canvas = createCanvas(columns, rows);
    const ctx = canvas.getContext('2d');

    // Step 4: Single pass through z-slices
    const axialSlice = new Uint8Array(sliceSize);

    try {
        for (let z = 0; z < depth; z++) {
            loadSlice(srcFd, readBuf, z, sliceFloat, sliceSize);

            // Apply windowing and scatter
            for (let y = 0; y < rows; y++) {
                for (let x = 0; x < columns; x++) {
                    const srcIdx = y * columns + x;
                    const val = applyWindow(sliceFloat[srcIdx], windowLow, windowHigh, windowWidth);

                    // Axial buffer (written immediately)
                    axialSlice[srcIdx] = val;

                    // Scatter to sagittal: image index=x, pixel at (col=z, row=y) in a depth x rows image
                    sagittalAll[x * (depth * rows) + y * depth + z] = val;

                    // Scatter to coronal: image index=y, pixel at (x, z) in a columns x depth image
                    coronalAll[y * (columns * depth) + z * columns + x] = val;
                }
            }

            // Write axial JPG + bump immediately
            setProcessingStatus(`Creating axial_${pad3(z)}.jpg (${z + 1}/${depth})...`);
            writeJpg(canvas, ctx, axialSlice, columns, rows, path.join(axialDir, `axial_${pad3(z)}.jpg`));
            writeBumpJpg(canvas, ctx, axialSlice, columns, rows, path.join(axialBumpDir, `axial_${pad3(z)}_bump.jpg`));

            if (z % 10 === 0) {
                if (gc) gc();
                await yieldToEventLoop();
            }
        }
    } finally {
        fs.closeSync(srcFd);
    }

    logMemory('mpr-axial-done');

    // Step 5: Render sagittal JPGs (one per column x)
    // Each sagittal image: width=depth, height=rows (Z horizontal, Y vertical)
    const sagittalSlice = new Uint8Array(depth * rows);
    for (let x = 0; x < columns; x++) {
        const offset = x * (depth * rows);
        setProcessingStatus(`Creating sagittal_${pad3(x)}.jpg (${x + 1}/${columns})...`);
        sagittalSlice.set(sagittalAll.subarray(offset, offset + depth * rows));
        writeJpg(canvas, ctx, sagittalSlice, depth, rows, path.join(sagittalDir, `sagittal_${pad3(x)}.jpg`));
        writeBumpJpg(canvas, ctx, sagittalSlice, depth, rows, path.join(sagittalBumpDir, `sagittal_${pad3(x)}_bump.jpg`));

        if (x % 10 === 0) {
            if (gc) gc();
            await yieldToEventLoop();
        }
    }
    sagittalAll = null;

    logMemory('mpr-sagittal-done');

    // Step 6: Render coronal JPGs (one per row y)
    // Each coronal image: width=columns, height=depth
    const coronalSlice = new Uint8Array(columns * depth);
    for (let y = 0; y < rows; y++) {
        const offset = y * (columns * depth);
        setProcessingStatus(`Creating coronal_${pad3(y)}.jpg (${y + 1}/${rows})...`);
        coronalSlice.set(coronalAll.subarray(offset, offset + columns * depth));
        writeJpg(canvas, ctx, coronalSlice, columns, depth, path.join(coronalDir, `coronal_${pad3(y)}.jpg`));
        writeBumpJpg(canvas, ctx, coronalSlice, columns, depth, path.join(coronalBumpDir, `coronal_${pad3(y)}_bump.jpg`));

        if (y % 10 === 0) {
            if (gc) gc();
            await yieldToEventLoop();
        }
    }
    coronalAll = null;

    // Step 7: Release canvas memory
    canvas.width = 1;
    canvas.height = 1;

    if (gc) gc();
    logMemory('mpr-done');

    // Step 8: Write mpr_info.json
    const mprInfo = {
        axial: { count: depth, width: columns, height: rows },
        sagittal: { count: columns, width: depth, height: rows },
        coronal: { count: rows, width: columns, height: depth },
        spacing: spacing,
        windowCenter: Math.round(windowCenter),
        windowWidth: Math.round(windowWidth),
        windowSource: windowSource
    };

    fs.writeFileSync(path.join(mprDir, 'mpr_info.json'), JSON.stringify(mprInfo, null, 2));

    // Counting the bump variants too: this used to report half the images it had just written.
    const planeTotal = depth + columns + rows;
    console.log(`MPR complete: ${depth} axial + ${columns} sagittal + ${rows} coronal = ` +
        `${planeTotal} slices, ${planeTotal * 2} images including bump maps`);

    return mprDir;
}
