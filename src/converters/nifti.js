import fs from 'fs';
import { DicomMetaDictionary, DicomMessage } from '../utils/dicomHelpers.js';
import { extractPixelData, yieldToEventLoop } from '../utils/pixelData.js';

export async function convertToNifti(dicomFiles, outputPath) {
    console.log('Converting DICOM to NIfTI...');

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

    // Create NIfTI-1 header (348 bytes)
    const header = Buffer.alloc(348);

    header.writeInt32LE(348, 0);
    header.write('', 4, 10, 'ascii');
    header.write('', 14, 18, 'ascii');
    header.writeInt32LE(0, 32);
    header.writeInt16LE(0, 36);
    header.write('r', 38, 1, 'ascii');
    header.writeUInt8(0, 39);

    // dim[8]
    header.writeInt16LE(3, 40);
    header.writeInt16LE(columns, 42);
    header.writeInt16LE(rows, 44);
    header.writeInt16LE(depth, 46);
    header.writeInt16LE(1, 48);
    header.writeInt16LE(1, 50);
    header.writeInt16LE(1, 52);
    header.writeInt16LE(1, 54);

    header.writeFloatLE(0, 56);
    header.writeFloatLE(0, 60);
    header.writeFloatLE(0, 64);
    header.writeInt16LE(0, 68);
    header.writeInt16LE(16, 70); // datatype = float32
    header.writeInt16LE(32, 72); // bitpix
    header.writeInt16LE(0, 74);

    // pixdim[8]
    header.writeFloatLE(1.0, 76);
    header.writeFloatLE(spacing[0], 80);
    header.writeFloatLE(spacing[1], 84);
    header.writeFloatLE(spacing[2], 88);
    header.writeFloatLE(1.0, 92);
    header.writeFloatLE(0, 96);
    header.writeFloatLE(0, 100);
    header.writeFloatLE(0, 104);

    header.writeFloatLE(352, 108); // vox_offset
    header.writeFloatLE(1.0, 112); // scl_slope
    header.writeFloatLE(0.0, 116); // scl_inter
    header.writeInt16LE(0, 120);
    header.writeUInt8(0, 122);
    header.writeUInt8(2, 123); // xyzt_units = mm
    header.writeFloatLE(0, 124);
    header.writeFloatLE(0, 128);
    header.writeFloatLE(0, 132);
    header.writeFloatLE(0, 136);
    header.writeInt32LE(0, 140);
    header.writeInt32LE(0, 144);

    header.write('DICOM to NIfTI conversion', 148, 80, 'ascii');
    header.write('', 228, 24, 'ascii');

    header.writeInt16LE(1, 252); // qform_code
    header.writeInt16LE(1, 254); // sform_code

    // quaternion
    header.writeFloatLE(0, 256);
    header.writeFloatLE(0, 260);
    header.writeFloatLE(0, 264);

    // qoffset (origin)
    header.writeFloatLE(origin[0], 268);
    header.writeFloatLE(origin[1], 272);
    header.writeFloatLE(origin[2], 276);

    // srow_x
    header.writeFloatLE(spacing[0], 280);
    header.writeFloatLE(0, 284);
    header.writeFloatLE(0, 288);
    header.writeFloatLE(origin[0], 292);

    // srow_y
    header.writeFloatLE(0, 296);
    header.writeFloatLE(spacing[1], 300);
    header.writeFloatLE(0, 304);
    header.writeFloatLE(origin[1], 308);

    // srow_z
    header.writeFloatLE(0, 312);
    header.writeFloatLE(0, 316);
    header.writeFloatLE(spacing[2], 320);
    header.writeFloatLE(origin[2], 324);

    header.write('', 328, 16, 'ascii');
    header.write('n+1\0', 344, 4, 'ascii'); // magic

    fs.writeFileSync(outputPath, header);

    // 4-byte extension (all zeros)
    const extension = Buffer.alloc(4, 0);
    fs.appendFileSync(outputPath, extension);

    // Volume data
    fs.appendFileSync(outputPath, Buffer.from(volumeData.buffer));

    console.log('Successfully wrote NIfTI file:', outputPath);
    return outputPath;
}
