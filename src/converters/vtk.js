import fs from 'fs';

export async function convertToVtk(volume, outputPath) {
    console.log('Converting DICOM to VTK legacy...');

    const { volumeData, dimensions, spacing, origin } = volume;
    const { rows, columns, depth } = dimensions;

    const vtkContent = `# vtk DataFile Version 3.0
converted from DICOM
BINARY
DATASET STRUCTURED_POINTS
DIMENSIONS ${columns} ${rows} ${depth}
ORIGIN ${origin.join(' ')}
SPACING ${spacing.join(' ')}
POINT_DATA ${volumeData.length}
SCALARS intensity float
LOOKUP_TABLE default
`;

    fs.writeFileSync(outputPath, vtkContent);
    fs.appendFileSync(outputPath, Buffer.from(volumeData.buffer));

    console.log(`Successfully converted to VTK: ${outputPath}`);
    return outputPath;
}
