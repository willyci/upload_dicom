import fs from 'fs';
import { DicomMetaDictionary, DicomMessage } from '../utils/dicomHelpers.js';
import { extractPixelData, yieldToEventLoop } from '../utils/pixelData.js';

/**
 * Generate VTI XML content manually (vtk.js doesn't work in Node.js).
 * VTK XML binary format requires: base64( UInt32_header(byteCount) + data )
 */
function generateVTI(dimensions, spacing, origin, volumeData) {
    const [nx, ny, nz] = dimensions;
    const [sx, sy, sz] = spacing;
    const [ox, oy, oz] = origin;

    // VTK XML binary format: prepend a UInt32 header with the byte count
    const dataBytes = Buffer.from(volumeData.buffer);
    const header = Buffer.alloc(4);
    header.writeUInt32LE(dataBytes.length, 0);
    const base64Data = Buffer.concat([header, dataBytes]).toString('base64');

    const xml = `<?xml version="1.0"?>
<VTKFile type="ImageData" version="1.0" byte_order="LittleEndian" header_type="UInt32">
  <ImageData WholeExtent="0 ${nx - 1} 0 ${ny - 1} 0 ${nz - 1}" Origin="${ox} ${oy} ${oz}" Spacing="${sx} ${sy} ${sz}">
    <Piece Extent="0 ${nx - 1} 0 ${ny - 1} 0 ${nz - 1}">
      <PointData Scalars="Scalars">
        <DataArray type="Float32" Name="Scalars" format="binary" NumberOfTuples="${nx * ny * nz}">
${base64Data}
        </DataArray>
      </PointData>
    </Piece>
  </ImageData>
</VTKFile>`;

    return xml;
}

export async function convertToVti(dicomFiles, outputPath) {
    console.log('Converting DICOM to VTI...');

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

    // Generate VTI XML manually (vtk.js doesn't work in Node.js)
    const vtiContent = generateVTI(
        [columns, rows, depth],
        spacing,
        origin,
        volumeData
    );

    fs.writeFileSync(outputPath, vtiContent, 'utf8');

    console.log('Successfully wrote VTI file:', outputPath);
    return outputPath;
}
