import fs from 'fs';
import path from 'path';
import dicomParser from 'dicom-parser';
import { convertToJpgFromDataset, generateBumpMap } from '../converters/jpg.js';
import { convertToVti } from '../converters/vti.js';
import { convertToNrrd } from '../converters/nrrd.js';
import { convertToNifti } from '../converters/nifti.js';
import { convertToStl } from '../converters/stl.js';
import { convertToVtk } from '../converters/vtk.js';
import { showDicomInfo } from '../utils/dicomInfo.js';
import { buildVolumeData } from '../utils/volumeBuilder.js';
import { removePathBeforeUploads } from '../utils/paths.js';
import { DicomMetaDictionary, DicomMessage } from '../utils/dicomHelpers.js';

// Recursively find all .dcm files in a directory tree
async function findDcmFilesRecursive(dir) {
    const results = [];
    const items = await fs.promises.readdir(dir, { withFileTypes: true });
    for (const item of items) {
        const fullPath = path.join(dir, item.name);
        if (item.isDirectory()) {
            const nested = await findDcmFilesRecursive(fullPath);
            results.push(...nested);
        } else if (item.name.toLowerCase().endsWith('.dcm')) {
            results.push(fullPath);
        }
    }
    return results;
}

export async function processDirectory(dirPath) {
    const processedFiles = [];
    const errors = [];

    // Recursively collect all DICOM files from all subdirectories
    const dicomFiles = await findDcmFilesRecursive(dirPath);

    console.log(`Found ${dicomFiles.length} DICOM files to process (recursive scan of ${dirPath})`);

    // Build volume data ONCE for all converters
    let volume = null;
    try {
        volume = await buildVolumeData(dicomFiles);
    } catch (error) {
        console.error('Volume building failed:', error.message);
        errors.push({ converter: 'volumeBuilder', error: error.message });
    }

    // Run all 5 volume converters sequentially using the shared volume
    const vtiPath = path.join(dirPath, 'volume.vti');
    let vtiResult = null;
    if (volume) {
        try {
            await convertToVti(volume, vtiPath);
            vtiResult = vtiPath;
        } catch (error) {
            console.error('VTI conversion failed:', error.message);
            errors.push({ converter: 'vti', error: error.message });
        }
    }

    const nrrdPath = path.join(dirPath, 'volume.nrrd');
    let nrrdResult = null;
    if (volume) {
        try {
            await convertToNrrd(volume, nrrdPath);
            nrrdResult = nrrdPath;
        } catch (error) {
            console.error('NRRD conversion failed:', error.message);
            errors.push({ converter: 'nrrd', error: error.message });
        }
    }

    const niftiPath = path.join(dirPath, 'volume.nii');
    let niftiResult = null;
    if (volume) {
        try {
            await convertToNifti(volume, niftiPath);
            niftiResult = niftiPath;
        } catch (error) {
            console.error('NIfTI conversion failed:', error.message);
            errors.push({ converter: 'nifti', error: error.message });
        }
    }

    const stlPath = path.join(dirPath, 'model.stl');
    let stlResult = null;
    if (volume) {
        try {
            await convertToStl(volume, stlPath);
            stlResult = stlPath;
        } catch (error) {
            console.error('STL conversion failed:', error.message);
            errors.push({ converter: 'stl', error: error.message });
        }
    }

    const vtkLegacyPath = path.join(dirPath, 'volume.vtk');
    let vtkResult = null;
    if (volume) {
        try {
            await convertToVtk(volume, vtkLegacyPath);
            vtkResult = vtkLegacyPath;
        } catch (error) {
            console.error('VTK conversion failed:', error.message);
            errors.push({ converter: 'vtk', error: error.message });
        }
    }

    // Release volume data to free ~394 MB
    volume = null;

    // Process individual DICOM files for JPG + bump maps
    // Read each file ONCE, parse with both dcmjs and dicom-parser, then reuse
    for (const filePath of dicomFiles) {
        try {
            const dicomFileBuffer = fs.readFileSync(filePath);

            // Parse with dcmjs for JPG conversion and dicomInfo
            const dicomData = DicomMessage.readFile(dicomFileBuffer.buffer);
            const dcmjsDataset = DicomMetaDictionary.naturalizeDataset(dicomData.dict);

            const outputPath = `${filePath}.jpg`;
            await convertToJpgFromDataset(dcmjsDataset, outputPath);

            // Parse with dicom-parser for bump map generation
            const bumpMapPath = `${filePath}_bump.jpg`;
            try {
                const dataSet = dicomParser.parseDicom(dicomFileBuffer);
                await generateBumpMap(dataSet, bumpMapPath);
            } catch (bumpError) {
                console.error(`Error generating bump map for ${path.basename(filePath)}:`, bumpError.message);
            }

            const dicomInfo = showDicomInfo(filePath, dcmjsDataset);
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
        } catch (error) {
            console.error(`Error processing file ${path.basename(filePath)}:`, error.message);
            errors.push({ converter: 'jpg', file: path.basename(filePath), error: error.message });
        }
    }

    return { processedFiles, errors };
}
