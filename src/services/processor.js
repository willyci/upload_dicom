import fs from 'fs';
import path from 'path';
import dicomParser from 'dicom-parser';
import { convertToJpg, generateBumpMap } from '../converters/jpg.js';
import { convertToVti } from '../converters/vti.js';
import { convertToNrrd } from '../converters/nrrd.js';
import { convertToNifti } from '../converters/nifti.js';
import { convertToStl } from '../converters/stl.js';
import { convertToVtk } from '../converters/vtk.js';
import { showDicomInfo } from '../utils/dicomInfo.js';
import { removePathBeforeUploads } from '../utils/paths.js';

export async function processDirectory(dirPath) {
    const files = await fs.promises.readdir(dirPath);
    const processedFiles = [];
    const dicomFiles = [];
    const errors = [];

    console.log(`Processing ${files.length} files in directory:`, dirPath);

    // First pass: collect all DICOM files
    for (const file of files) {
        const filePath = path.join(dirPath, file);
        if (filePath.toLowerCase().endsWith('.dcm')) {
            dicomFiles.push(filePath);
        }
    }

    console.log(`Found ${dicomFiles.length} DICOM files to process.`);

    // Run volume converters with individual error handling
    const vtiPath = path.join(dirPath, 'volume.vti');
    let vtiResult = null;
    try {
        await convertToVti(dicomFiles, vtiPath);
        vtiResult = vtiPath;
    } catch (error) {
        console.error('VTI conversion failed:', error.message);
        errors.push({ converter: 'vti', error: error.message });
    }

    const nrrdPath = path.join(dirPath, 'volume.nrrd');
    let nrrdResult = null;
    try {
        await convertToNrrd(dicomFiles, nrrdPath);
        nrrdResult = nrrdPath;
    } catch (error) {
        console.error('NRRD conversion failed:', error.message);
        errors.push({ converter: 'nrrd', error: error.message });
    }

    const niftiPath = path.join(dirPath, 'volume.nii');
    let niftiResult = null;
    try {
        await convertToNifti(dicomFiles, niftiPath);
        niftiResult = niftiPath;
    } catch (error) {
        console.error('NIfTI conversion failed:', error.message);
        errors.push({ converter: 'nifti', error: error.message });
    }

    const stlPath = path.join(dirPath, 'model.stl');
    let stlResult = null;
    try {
        await convertToStl(dicomFiles, stlPath);
        stlResult = stlPath;
    } catch (error) {
        console.error('STL conversion failed:', error.message);
        errors.push({ converter: 'stl', error: error.message });
    }

    const vtkLegacyPath = path.join(dirPath, 'volume.vtk');
    let vtkResult = null;
    try {
        await convertToVtk(dicomFiles, vtkLegacyPath);
        vtkResult = vtkLegacyPath;
    } catch (error) {
        console.error('VTK conversion failed:', error.message);
        errors.push({ converter: 'vtk', error: error.message });
    }

    // Process individual DICOM files for JPG + bump maps
    for (const file of files) {
        const filePath = path.join(dirPath, file);
        const stats = await fs.promises.stat(filePath);

        if (stats.isFile()) {
            try {
                let currentPath = filePath;
                if (!path.extname(file)) {
                    const newPath = `${filePath}.dcm`;
                    await fs.promises.rename(filePath, newPath);
                    currentPath = newPath;
                }

                if (currentPath.toLowerCase().endsWith('.dcm')) {
                    const outputPath = `${currentPath}.jpg`;
                    await convertToJpg(currentPath, outputPath);

                    const bumpMapPath = `${currentPath}_bump.jpg`;
                    try {
                        const dicomFileBuffer = fs.readFileSync(currentPath);
                        const dataSet = dicomParser.parseDicom(dicomFileBuffer);
                        await generateBumpMap(dataSet, bumpMapPath);
                    } catch (bumpError) {
                        console.error(`Error generating bump map for ${file}:`, bumpError.message);
                    }

                    const dicomInfo = showDicomInfo(filePath);
                    processedFiles.push({
                        dicomPath: removePathBeforeUploads(filePath),
                        jpgPath: removePathBeforeUploads(outputPath),
                        bumpMapPath: removePathBeforeUploads(bumpMapPath),
                        vtiPath: vtiResult ? removePathBeforeUploads(vtiPath) : null,
                        nrrdPath: nrrdResult ? removePathBeforeUploads(nrrdPath) : null,
                        niftiPath: niftiResult ? removePathBeforeUploads(niftiPath) : null,
                        stlPath: stlResult ? removePathBeforeUploads(stlPath) : null,
                        vtkLegacyPath: vtkResult ? removePathBeforeUploads(vtkLegacyPath) : null,
                        dicomInfo: dicomInfo
                    });
                }
            } catch (error) {
                console.error(`Error processing file ${file}:`, error.message);
                errors.push({ converter: 'jpg', file, error: error.message });
            }
        }
    }

    return { processedFiles, errors };
}
