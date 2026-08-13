import fs from 'fs';
import { createCanvas } from 'canvas';
import { DicomMetaDictionary, DicomMessage } from '../utils/dicomHelpers.js';

export async function convertToJpgFromDataset(dataset, outputPath) {
    return _convertDatasetToJpg(dataset, outputPath);
}

export async function convertToJpg(inputPath, outputPath) {
    const dicomFileBuffer = fs.readFileSync(inputPath);
    const dicomData = DicomMessage.readFile(dicomFileBuffer.buffer);
    const dataset = DicomMetaDictionary.naturalizeDataset(dicomData.dict);
    return _convertDatasetToJpg(dataset, outputPath);
}

function _convertDatasetToJpg(dataset, outputPath) {

    let rawPixelData;
    if (!dataset.PixelData) {
        throw new Error("No pixel data found in DICOM file");
    }

    if (dataset.PixelData.buffer) {
        rawPixelData = dataset.PixelData;
    } else if (typeof dataset.PixelData === 'object' && dataset.PixelData[0] && dataset.PixelData[0].buffer) {
        rawPixelData = dataset.PixelData[0];
    } else if (typeof dataset.PixelData === 'string') {
        const buffer = Buffer.from(dataset.PixelData, 'base64');
        rawPixelData = new Uint8Array(buffer);
    } else {
        rawPixelData = dataset.PixelData.byteArray || dataset.PixelData;
    }

    const width = dataset.Columns;
    const height = dataset.Rows;

    if (!width || !height) {
        throw new Error("Invalid image dimensions in DICOM file");
    }

    const bitsAllocated = dataset.BitsAllocated || 16;
    const pixelRepresentation = dataset.PixelRepresentation || 0;
    const samplesPerPixel = dataset.SamplesPerPixel || 1;
    const photometricInterpretation = dataset.PhotometricInterpretation || 'MONOCHROME2';
    const rescaleSlope = dataset.RescaleSlope || 1;
    const rescaleIntercept = dataset.RescaleIntercept || 0;

    let pixelData;
    if (Array.isArray(rawPixelData) && rawPixelData[0] instanceof ArrayBuffer) {
        rawPixelData = rawPixelData[0];
    }
    if (bitsAllocated <= 8) {
        pixelData = new Uint8Array(rawPixelData);
    } else if (pixelRepresentation === 0) {
        pixelData = new Uint16Array(rawPixelData);
    } else {
        pixelData = new Int16Array(rawPixelData);
    }

    let windowCenter = dataset.WindowCenter;
    let windowWidth = dataset.WindowWidth;

    if (Array.isArray(windowCenter)) windowCenter = windowCenter[0];
    if (Array.isArray(windowWidth)) windowWidth = windowWidth[0];

    if (!windowCenter || !windowWidth) {
        let min = Infinity;
        let max = -Infinity;

        for (let i = 0; i < Math.min(pixelData.length, width * height); i++) {
            const value = pixelData[i] * rescaleSlope + rescaleIntercept;
            if (value < min) min = value;
            if (value > max) max = value;
        }

        windowCenter = (max + min) / 2;
        windowWidth = max - min;

        if (windowWidth < 10) windowWidth = max * 2;
    }

    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d');
    const imageData = ctx.createImageData(width, height);

    // The windowed 8-bit image, kept so the bump map can be derived from it rather than from raw
    // stored values. Gradients on windowed data are what mpr.js already uses, and they produce a far
    // less noisy - and much smaller - JPEG.
    let grey = null;

    if (samplesPerPixel === 1) {
        let pixelIndex = 0;
        grey = new Uint8Array(width * height);

        const windowLow = windowCenter - windowWidth / 2;
        const windowHigh = windowCenter + windowWidth / 2;

        for (let i = 0; i < Math.min(pixelData.length, width * height); i++) {
            let pixelValue = pixelData[i] * rescaleSlope + rescaleIntercept;

            if (pixelValue <= windowLow) {
                pixelValue = 0;
            } else if (pixelValue >= windowHigh) {
                pixelValue = 255;
            } else {
                pixelValue = ((pixelValue - windowLow) / windowWidth) * 255;
            }

            if (photometricInterpretation === 'MONOCHROME1') {
                pixelValue = 255 - pixelValue;
            }

            pixelValue = Math.max(0, Math.min(255, Math.round(pixelValue)));

            grey[i] = pixelValue;
            imageData.data[pixelIndex++] = pixelValue;
            imageData.data[pixelIndex++] = pixelValue;
            imageData.data[pixelIndex++] = pixelValue;
            imageData.data[pixelIndex++] = 255;
        }
    } else if (samplesPerPixel === 3) {
        let pixelIndex = 0;

        if (pixelData.length >= width * height * 3) {
            for (let i = 0; i < width * height * 3; i += 3) {
                if (i + 2 < pixelData.length) {
                    imageData.data[pixelIndex++] = Math.max(0, Math.min(255, pixelData[i]));
                    imageData.data[pixelIndex++] = Math.max(0, Math.min(255, pixelData[i + 1]));
                    imageData.data[pixelIndex++] = Math.max(0, Math.min(255, pixelData[i + 2]));
                    imageData.data[pixelIndex++] = 255;
                }
            }
        } else {
            for (let i = 0; i < width * height; i++) {
                imageData.data[pixelIndex++] = 100;
                imageData.data[pixelIndex++] = 100;
                imageData.data[pixelIndex++] = 100;
                imageData.data[pixelIndex++] = 255;
            }
        }
    }

    ctx.putImageData(imageData, 0, 0);

    const buffer = canvas.toBuffer('image/jpeg', { quality: 0.9 });
    fs.writeFileSync(outputPath, buffer);

    // Release native Cairo surface memory immediately.
    // V8 GC doesn't track native memory, so without this, 265 canvases
    // accumulate ~265 MB of invisible native memory that eventually kills the process.
    canvas.width = 1;
    canvas.height = 1;

    return { windowCenter, windowWidth, grey, width, height };
}

/**
 * Bump map from an already-windowed 8-bit image.
 *
 * Takes the grey buffer produced alongside the JPEG rather than re-reading the DICOM. That removes a
 * third full parse of every slice, and fixes three faults in the old signature: it read Rows into
 * `width` and Columns into `height` (transposed on any non-square slice), it built an unbounded
 * `Int16Array` view over the file buffer regardless of BitsAllocated (and threw outright if the pixel
 * offset happened to be odd), and it took gradients on raw stored values, which is why these files
 * were 3.6x larger than the equivalent MPR bump maps for the same image.
 *
 * Also gone: the putImageData -> getImageData -> scan -> putImageData round-trip, ~3 MB of native
 * surface copying per image, which existed only to find a min and a max the gradient loop already
 * had in hand.
 */
export async function generateBumpMap(source, outputPath) {
    const { grey, width, height } = source || {};
    if (!grey || !width || !height)
        throw new Error('Bump map needs a windowed greyscale image');

    const gradient = new Uint8Array(width * height);

    for (let y = 1; y < height - 1; y++) {
        const row = y * width;
        for (let x = 1; x < width - 1; x++) {
            const idx = row + x;
            const gx = grey[idx + 1] - grey[idx - 1];

            // Matches the previous output: the red/green channels carry the normalised x gradient and
            // blue is pinned to 255. The old code computed a y gradient too but then overwrote it
            // during normalisation, so it never reached the file.
            let value = Math.floor(((gx / 255) + 1) * 127.5);
            if (value < 0) value = 0; else if (value > 255) value = 255;

            gradient[idx] = value;
        }
    }

    // Whole buffer, border included - the unwritten border contributes zeros and pins the minimum,
    // which is what the old full-surface getImageData scan did.
    let min = 255, max = 0;
    for (let i = 0; i < gradient.length; i++) {
        const v = gradient[i];
        if (v < min) min = v;
        if (v > max) max = v;
    }

    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d');
    const imageData = ctx.createImageData(width, height);
    const scale = max > min ? 255 / (max - min) : 0;

    // Interior only: the border stays transparent and flattens to black, as it did before.
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

    const buffer = canvas.toBuffer('image/jpeg', { quality: 0.9 });
    fs.writeFileSync(outputPath, buffer);

    // Release native Cairo surface memory immediately
    canvas.width = 1;
    canvas.height = 1;
}
