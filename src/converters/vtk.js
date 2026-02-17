import fs from 'fs';
import { appendVolumeToFile } from '../utils/volumeBuilder.js';

export async function convertToVtk(volume, outputPath) {
    console.log('Converting DICOM to VTK legacy...');

    const { tempFilePath, dimensions, spacing, origin } = volume;
    const { rows, columns, depth } = dimensions;
    const totalVoxels = rows * columns * depth;

    const vtkContent = `# vtk DataFile Version 3.0
converted from DICOM
BINARY
DATASET STRUCTURED_POINTS
DIMENSIONS ${columns} ${rows} ${depth}
ORIGIN ${origin.join(' ')}
SPACING ${spacing.join(' ')}
POINT_DATA ${totalVoxels}
SCALARS intensity float
LOOKUP_TABLE default
`;

    fs.writeFileSync(outputPath, vtkContent);
    appendVolumeToFile(tempFilePath, outputPath);

    console.log(`Successfully converted to VTK: ${outputPath}`);
    return outputPath;
}
