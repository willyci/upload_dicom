import fs from 'fs';
import { appendVolumeToFile, resolveOutputDtype, describeDtype } from '../utils/volumeStream.js';

export async function convertToVtk(volume, outputPath) {
    console.log('Converting DICOM to VTK legacy...');

    const { dimensions, spacing, origin } = volume;
    const { rows, columns, depth } = dimensions;
    const totalVoxels = rows * columns * depth;

    // The legacy format has no compression, so int16 is the only saving available here.
    const dtype = resolveOutputDtype(volume);
    console.log('VTK data type:', describeDtype(volume, dtype));

    const vtkContent = `# vtk DataFile Version 3.0
converted from DICOM
BINARY
DATASET STRUCTURED_POINTS
DIMENSIONS ${columns} ${rows} ${depth}
ORIGIN ${origin.join(' ')}
SPACING ${spacing.join(' ')}
POINT_DATA ${totalVoxels}
SCALARS intensity ${dtype === 'int16' ? 'short' : 'float'}
LOOKUP_TABLE default
`;

    fs.writeFileSync(outputPath, vtkContent);
    await appendVolumeToFile(volume, outputPath, dtype);

    console.log(`Successfully converted to VTK: ${outputPath}`);
    return outputPath;
}
