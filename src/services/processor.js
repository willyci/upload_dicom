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
import { yieldToEventLoop } from '../utils/pixelData.js';

const gc = typeof global.gc === 'function' ? global.gc : null;

function logMemory(label) {
    const mem = process.memoryUsage();
    console.log(`[MEM ${label}] RSS: ${Math.round(mem.rss / 1024 / 1024)} MB | Heap: ${Math.round(mem.heapUsed / 1024 / 1024)}/${Math.round(mem.heapTotal / 1024 / 1024)} MB`);
}

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

/**
 * Process a single DICOM file for JPG + bump map + dicom info.
 * Reuses the already-parsed dcmjs dataset and raw buffer from the volume builder.
 */
async function processFileForJpg(filePath, rawBuffer, dcmjsDataset, errors) {
    const outputPath = `${filePath}.jpg`;
    let dicomInfo = null;
    let bumpMapPath = `${filePath}_bump.jpg`;

    try {
        await convertToJpgFromDataset(dcmjsDataset, outputPath);
        dicomInfo = showDicomInfo(filePath, dcmjsDataset);
    } catch (error) {
        console.error(`Error processing file ${path.basename(filePath)}:`, error.message);
        errors.push({ converter: 'jpg', file: path.basename(filePath), error: error.message });
        return null;
    }

    try {
        const dataSet = dicomParser.parseDicom(rawBuffer);
        await generateBumpMap(dataSet, bumpMapPath);
    } catch (bumpError) {
        console.error(`Error generating bump map for ${path.basename(filePath)}:`, bumpError.message);
    }

    return { outputPath, bumpMapPath, dicomInfo };
}

export async function processDirectory(dirPath) {
    const errors = [];

    // Recursively collect all DICOM files from all subdirectories
    const dicomFiles = await findDcmFilesRecursive(dirPath);

    console.log(`Found ${dicomFiles.length} DICOM files to process (recursive scan of ${dirPath})`);

    // jpgResults collects per-file output during the volume build callback
    const jpgResults = new Map();

    // Build volume data ONCE for all converters.
    // The onSliceParsed callback piggybacks JPG/bump processing on the same dcmjs parse,
    // so each file is only read and parsed ONCE instead of twice.
    let volume = null;
    try {
        volume = await buildVolumeData(dicomFiles, async (filePath, rawBuffer, dcmjsDataset) => {
            const result = await processFileForJpg(filePath, rawBuffer, dcmjsDataset, errors);
            if (result) {
                jpgResults.set(filePath, result);
            }
        });
    } catch (error) {
        console.error('Volume building failed:', error.message);
        errors.push({ converter: 'volumeBuilder', error: error.message });
    }

    // Fallback: process any files that weren't handled by the callback
    // (e.g. if volume building failed before starting the second pass)
    logMemory('jpg-fallback-check');
    for (let fi = 0; fi < dicomFiles.length; fi++) {
        const filePath = dicomFiles[fi];
        if (jpgResults.has(filePath)) continue;

        try {
            let rawBuffer = fs.readFileSync(filePath);
            let dicomData = DicomMessage.readFile(rawBuffer.buffer);
            let dcmjsDataset = DicomMetaDictionary.naturalizeDataset(dicomData.dict);

            const result = await processFileForJpg(filePath, rawBuffer, dcmjsDataset, errors);
            if (result) {
                jpgResults.set(filePath, result);
            }

            rawBuffer = null;
            dicomData = null;
            dcmjsDataset = null;
        } catch (error) {
            console.error(`Error processing file ${path.basename(filePath)}:`, error.message);
            errors.push({ converter: 'jpg', file: path.basename(filePath), error: error.message });
        }

        if (fi % 10 === 0) {
            if (gc) gc();
            await yieldToEventLoop();
        }
    }

    // Run all 5 volume converters, then clean up temp file
    const vtiPath = path.join(dirPath, 'volume.vti');
    const nrrdPath = path.join(dirPath, 'volume.nrrd');
    const niftiPath = path.join(dirPath, 'volume.nii');
    const stlPath = path.join(dirPath, 'model.stl');
    const vtkLegacyPath = path.join(dirPath, 'volume.vtk');
    let vtiResult = null, nrrdResult = null, niftiResult = null, stlResult = null, vtkResult = null;

    if (volume) {
        try {
            try { await convertToVti(volume, vtiPath); vtiResult = vtiPath; }
            catch (error) { console.error('VTI conversion failed:', error.message); errors.push({ converter: 'vti', error: error.message }); }

            try { await convertToNrrd(volume, nrrdPath); nrrdResult = nrrdPath; }
            catch (error) { console.error('NRRD conversion failed:', error.message); errors.push({ converter: 'nrrd', error: error.message }); }

            try { await convertToNifti(volume, niftiPath); niftiResult = niftiPath; }
            catch (error) { console.error('NIfTI conversion failed:', error.message); errors.push({ converter: 'nifti', error: error.message }); }

            try { await convertToStl(volume, stlPath); stlResult = stlPath; }
            catch (error) { console.error('STL conversion failed:', error.message); errors.push({ converter: 'stl', error: error.message }); }

            try { await convertToVtk(volume, vtkLegacyPath); vtkResult = vtkLegacyPath; }
            catch (error) { console.error('VTK conversion failed:', error.message); errors.push({ converter: 'vtk', error: error.message }); }
        } finally {
            volume.cleanup();
            volume = null;
        }
    }

    logMemory('processing-done');

    // Build processedFiles in original file order
    const processedFiles = [];
    for (const filePath of dicomFiles) {
        const result = jpgResults.get(filePath);
        if (result) {
            processedFiles.push({
                dicomPath: removePathBeforeUploads(filePath),
                jpgPath: removePathBeforeUploads(result.outputPath),
                bumpMapPath: removePathBeforeUploads(result.bumpMapPath),
                vtiPath: vtiResult ? removePathBeforeUploads(vtiPath) : null,
                nrrdPath: nrrdResult ? removePathBeforeUploads(nrrdPath) : null,
                niftiPath: niftiResult ? removePathBeforeUploads(niftiPath) : null,
                stlPath: stlResult ? removePathBeforeUploads(stlPath) : null,
                vtkLegacyPath: vtkResult ? removePathBeforeUploads(vtkLegacyPath) : null,
                dicomInfo: result.dicomInfo
            });
        }
    }

    return { processedFiles, errors };
}
