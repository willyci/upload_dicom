import fs from 'fs';
import { DicomMetaDictionary, DicomMessage } from './dicomHelpers.js';
import { extractPixelData, yieldToEventLoop } from './pixelData.js';

/**
 * Build volume data from DICOM files once, for sharing across all converters.
 * Returns { volumeData, dimensions: { rows, columns, depth }, spacing, origin }
 */
export async function buildVolumeData(dicomFiles) {
    const slices = [];

    for (const filePath of dicomFiles) {
        const dicomFileBuffer = fs.readFileSync(filePath);
        const dicomData = DicomMessage.readFile(dicomFileBuffer.buffer);
        const dataset = DicomMetaDictionary.naturalizeDataset(dicomData.dict);

        const position = dataset.ImagePositionPatient || [0, 0, 0];
        const spacing = dataset.PixelSpacing || [1, 1];
        const sliceThickness = dataset.SliceThickness || 1;

        slices.push({
            filePath,
            position,
            spacing: [...spacing, sliceThickness],
            rows: dataset.Rows,
            columns: dataset.Columns,
            zPosition: position[2]
        });
    }

    if (slices.length === 0) {
        throw new Error('No DICOM files found');
    }

    slices.sort((a, b) => a.zPosition - b.zPosition);

    const rows = slices[0].rows;
    const columns = slices[0].columns;
    const depth = slices.length;
    const spacing = slices[0].spacing;
    const origin = slices[0].position;

    const totalSize = rows * columns * depth;
    const volumeData = new Float32Array(totalSize);

    for (let z = 0; z < depth; z++) {
        const slice = slices[z];

        const dicomFileBuffer = fs.readFileSync(slice.filePath);
        const dicomData = DicomMessage.readFile(dicomFileBuffer.buffer);
        const dataset = DicomMetaDictionary.naturalizeDataset(dicomData.dict);

        let pixelData;
        try {
            pixelData = extractPixelData(dataset);
        } catch (e) {
            console.warn(`Failed to extract pixel data for slice ${z}:`, e.message);
            pixelData = new Float32Array(rows * columns);
        }

        for (let i = 0; i < Math.min(pixelData.length, rows * columns); i++) {
            volumeData[z * rows * columns + i] = pixelData[i];
        }

        if (z % 20 === 0) await yieldToEventLoop();
    }

    return {
        volumeData,
        dimensions: { rows, columns, depth },
        spacing,
        origin
    };
}
