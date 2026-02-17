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

    if (samplesPerPixel === 1) {
        let pixelIndex = 0;

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

    return { windowCenter, windowWidth };
}

export async function generateBumpMap(dataSet, outputPath) {
    const width = dataSet.uint16('x00280010');
    const height = dataSet.uint16('x00280011');
    const pixelData = new Int16Array(dataSet.byteArray.buffer, dataSet.elements.x7fe00010.dataOffset);

    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d');
    const imageData = ctx.createImageData(width, height);

    for (let y = 1; y < height - 1; y++) {
        for (let x = 1; x < width - 1; x++) {
            const idx = (y * width + x);

            const gx = pixelData[idx + 1] - pixelData[idx - 1];
            const gy = pixelData[idx + width] - pixelData[idx - width];

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

    // Normalize: stretch pixel values to full 0-255 range
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

    const buffer = canvas.toBuffer('image/jpeg', { quality: 0.9 });
    fs.writeFileSync(outputPath, buffer);

    // Release native Cairo surface memory immediately
    canvas.width = 1;
    canvas.height = 1;
}
