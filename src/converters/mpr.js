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

/**
 * Scan a few sample z-slices to compute window center/width.
 */
function computeWindow(srcFd, readBuf, sliceSize, depth) {
    const sampleIndices = [];
    const step = Math.max(1, Math.floor(depth / 5));
    for (let i = 0; i < depth; i += step) {
        sampleIndices.push(i);
    }
    if (sampleIndices.length > 5) sampleIndices.length = 5;

    const sliceFloat = new Float32Array(sliceSize);
    let min = Infinity, max = -Infinity;

    for (const z of sampleIndices) {
        loadSlice(srcFd, readBuf, z, sliceFloat, sliceSize);
        for (let i = 0; i < sliceSize; i++) {
            const v = sliceFloat[i];
            if (v < min) min = v;
            if (v > max) max = v;
        }
    }

    const windowCenter = (max + min) / 2;
    let windowWidth = max - min;
    if (windowWidth < 10) windowWidth = max * 2;

    return { windowCenter, windowWidth };
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
function writeJpg(canvas, ctx, data, width, height, outputPath) {
    canvas.width = width;
    canvas.height = height;
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
 * Generate a bump map from a grayscale Uint8 slice and write as JPG.
 * Computes x/y gradients -> normal map -> normalize to full 0-255 range.
 */
function writeBumpJpg(canvas, ctx, data, width, height, outputPath) {
    canvas.width = width;
    canvas.height = height;
    const imageData = ctx.createImageData(width, height);

    for (let y = 1; y < height - 1; y++) {
        for (let x = 1; x < width - 1; x++) {
            const idx = y * width + x;
            const gx = data[idx + 1] - data[idx - 1];
            const gy = data[idx + width] - data[idx - width];

            const normalX = Math.floor(((gx / 255) + 1) * 127.5);
            const normalY = Math.floor(((gy / 255) + 1) * 127.5);

            const outIdx = idx * 4;
            imageData.data[outIdx] = normalX;
            imageData.data[outIdx + 1] = normalY;
            imageData.data[outIdx + 2] = 255;
            imageData.data[outIdx + 3] = 255;
        }
    }

    ctx.putImageData(imageData, 0, 0);

    // Normalize: stretch R channel to full 0-255 range
    const outData = ctx.getImageData(0, 0, width, height);
    let min = 255, max = 0;
    for (let i = 0; i < outData.data.length; i += 4) {
        const v = outData.data[i];
        if (v < min) min = v;
        if (v > max) max = v;
    }
    if (max > min) {
        const scale = 255 / (max - min);
        for (let i = 0; i < outData.data.length; i += 4) {
            const normalized = Math.round((outData.data[i] - min) * scale);
            outData.data[i] = normalized;
            outData.data[i + 1] = normalized;
            outData.data[i + 2] = 255;
        }
        ctx.putImageData(outData, 0, 0);
    }

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

    let windowCenter, windowWidth;
    try {
        // Step 2: Compute window from sample slices
        ({ windowCenter, windowWidth } = computeWindow(srcFd, readBuf, sliceSize, depth));
        console.log(`MPR window: center=${windowCenter.toFixed(1)}, width=${windowWidth.toFixed(1)}`);
    } catch (err) {
        fs.closeSync(srcFd);
        throw err;
    }

    const windowLow = windowCenter - windowWidth / 2;
    const windowHigh = windowCenter + windowWidth / 2;

    // Step 3: Allocate scatter buffers for sagittal and coronal
    // Sagittal (YZ plane, fixed X): each image is depth(W) x rows(H), one per column
    // sagittalAll[x * (depth * rows) + z * rows + y] = windowed value
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

                    // Scatter to sagittal: image index=x, pixel at (z, y) in a depth x rows image
                    sagittalAll[x * (depth * rows) + z * rows + y] = val;

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
    // Each sagittal image: width=depth, height=rows
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
        windowWidth: Math.round(windowWidth)
    };

    fs.writeFileSync(path.join(mprDir, 'mpr_info.json'), JSON.stringify(mprInfo, null, 2));

    console.log(`MPR complete: ${depth} axial + ${columns} sagittal + ${rows} coronal = ${depth + columns + rows} images`);

    return mprDir;
}
