import fs from 'fs';
import path from 'path';
import { convertToJpgFromDataset, generateBumpMap } from '../converters/jpg.js';
import { convertToVti } from '../converters/vti.js';
import { convertToNrrd } from '../converters/nrrd.js';
import { convertToNifti } from '../converters/nifti.js';
import { convertToStl } from '../converters/stl.js';
import { convertToVtk } from '../converters/vtk.js';
import { convertToMpr } from '../converters/mpr.js';
import { showDicomInfo } from '../utils/dicomInfo.js';
import { buildVolumeData } from '../utils/volumeBuilder.js';
import { removePathBeforeUploads } from '../utils/paths.js';
import { findDicomFiles } from '../utils/dicomFiles.js';
import { PUBLIC_DIR } from '../config.js';
import { DicomMetaDictionary, DicomMessage } from '../utils/dicomHelpers.js';
import { yieldToEventLoop } from '../utils/pixelData.js';
import { analyzeDicom } from './medgemma.js';
import { setProcessingStatus } from '../utils/progress.js';

const gc = typeof global.gc === 'function' ? global.gc : null;

function logMemory(label) {
    const mem = process.memoryUsage();
    console.log(`[MEM ${label}] RSS: ${Math.round(mem.rss / 1024 / 1024)} MB | Heap: ${Math.round(mem.heapUsed / 1024 / 1024)}/${Math.round(mem.heapTotal / 1024 / 1024)} MB`);
}

/**
 * Per-stage wall clock, printed as one line per stage plus a summary.
 *
 * Without this there is no way to tell which stage a change actually helped: the counts are easy to
 * reason about (files written, passes over the volume) but they are not the same as time.
 */
function createStageTimer() {
    const stages = [];
    let peakRss = 0;

    return {
        async run(name, work) {
            const started = process.hrtime.bigint();
            try {
                return await work();
            } finally {
                const ms = Number(process.hrtime.bigint() - started) / 1e6;
                const rss = process.memoryUsage().rss;
                if (rss > peakRss) peakRss = rss;
                stages.push({ name, ms });
                console.log(`[TIME] ${name.padEnd(18)} ${(ms / 1000).toFixed(2)} s   RSS ${Math.round(rss / 1048576)} MB`);
            }
        },

        report() {
            const total = stages.reduce((sum, s) => sum + s.ms, 0);
            console.log('\n[TIME] ---- stage summary ----');
            for (const { name, ms } of [...stages].sort((a, b) => b.ms - a.ms))
                console.log(`[TIME] ${name.padEnd(18)} ${(ms / 1000).toFixed(2)} s  ${(100 * ms / total).toFixed(1)}%`);
            console.log(`[TIME] ${'total'.padEnd(18)} ${(total / 1000).toFixed(2)} s   peak RSS ${Math.round(peakRss / 1048576)} MB\n`);

            // Handed back so it can travel to the browser: "which stage, and how long" is most of
            // what you want to know when something failed or took surprisingly long.
            return {
                stages: stages.map(s => ({ name: s.name, seconds: +(s.ms / 1000).toFixed(2) })),
                totalSeconds: +(total / 1000).toFixed(2),
                peakMemoryMb: Math.round(peakRss / 1048576),
            };
        },
    };
}

/**
 * One failure, described well enough to act on: which stage, which file, what the runtime said, and
 * the first few frames of where. Previously these carried only `error.message`, which for something
 * like "Cannot read properties of undefined" tells the user nothing at all.
 */
function record(errors, phase, error, extra = {}) {
    const entry = {
        phase,
        message: error?.message || String(error),
        type: error?.constructor?.name || typeof error,
        ...extra,
    };

    if (error?.code) entry.code = error.code;

    if (error?.stack) {
        // Just the frames from this codebase - node internals are noise here.
        entry.stack = error.stack.split('\n').slice(1, 6)
            .map(line => line.trim().replace(/^at\s+/, ''))
            .filter(line => !line.includes('node:internal'))
            .slice(0, 3);
    }

    errors.push(entry);
    console.error(`[FAIL ${phase}]${extra.file ? ' ' + extra.file : ''}: ${entry.message}`);
    if (entry.stack?.length) console.error('        at ' + entry.stack.join('\n        at '));

    return entry;
}

/**
 * Process a single DICOM file for JPG + bump map + dicom info.
 * Reuses the already-parsed dcmjs dataset and raw buffer from the volume builder.
 */
async function processFileForJpg(filePath, rawBuffer, dcmjsDataset, errors) {
    const outputPath = `${filePath}.jpg`;
    let dicomInfo = null;
    let bumpMapPath = `${filePath}_bump.jpg`;

    let rendered = null;
    try {
        rendered = await convertToJpgFromDataset(dcmjsDataset, outputPath);

        // Everything except the pixels. showDicomInfo hands back the whole naturalized dataset, and
        // this object is retained until the run finishes and then serialised into dicom_info.json -
        // so keeping PixelData here held every slice's pixels in memory for the whole job, defeating
        // the explicit releases in volumeBuilder. A shallow copy rather than a delete, because the
        // caller still owns the original.
        const info = showDicomInfo(filePath, dcmjsDataset);
        if (info) {
            const { PixelData, _vrMap, ...rest } = info;
            dicomInfo = rest;
        }
    } catch (error) {
        record(errors, 'jpg', error, { file: path.basename(filePath) });
        return null;
    }

    try {
        // Reuses the windowed image the JPEG was just made from. This used to parse the same buffer a
        // third time, purely because the bump map was written against the dicom-parser API.
        await generateBumpMap(rendered, bumpMapPath);
    } catch (bumpError) {
        // Reported rather than only logged: this used to fail silently, so a folder could come back
        // "successful" with no bump maps and no explanation.
        record(errors, 'bump map', bumpError, { file: path.basename(filePath) });
        bumpMapPath = null;
    }

    return { outputPath, bumpMapPath, dicomInfo };
}

export async function processDirectory(dirPath) {
    const errors = [];

    // Non-fatal: things the user should know happened, but which did not stop the upload.
    const warnings = [];

    // Filled in once the volume exists, and attached to converter failures for context.
    let volumeGeometry = null;

    const timer = createStageTimer();

    // Recursively collect all DICOM files from all subdirectories, extensionless ones included
    const dicomFiles = await findDicomFiles(dirPath);

    console.log(`Found ${dicomFiles.length} DICOM files to process (recursive scan of ${dirPath})`);

    // jpgResults collects per-file output during the volume build callback
    const jpgResults = new Map();

    // Build volume data ONCE for all converters.
    // The onSliceParsed callback piggybacks JPG/bump processing on the same dcmjs parse,
    // so each file is only read and parsed ONCE instead of twice.
    let volume = null;
    try {
        setProcessingStatus('Building volume data...');
        // Timed together because they are interleaved: the per-slice JPGs and bump maps are written
        // from inside the volume build's own parse, which is the whole point of the callback.
        volume = await timer.run('volume + jpgs', () => buildVolumeData(dicomFiles, async (filePath, rawBuffer, dcmjsDataset) => {
            setProcessingStatus(`Creating ${path.basename(filePath)}.jpg ...`);
            const result = await processFileForJpg(filePath, rawBuffer, dcmjsDataset, errors);
            if (result) {
                jpgResults.set(filePath, result);
            }
        }));
    } catch (error) {
        record(errors, 'volume build', error, {
            file: `${dicomFiles.length} DICOM files`,
            hint: 'Without a volume, none of the volume formats or MPR images can be produced.',
        });
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
            record(errors, 'parse', error, {
                file: path.basename(filePath),
                hint: 'The file could not be read as DICOM. It may be truncated, or use a compressed ' +
                    'transfer syntax this server cannot decode.',
            });
        }

        if (fi % 10 === 0) {
            if (gc) gc();
            await yieldToEventLoop();
        }
    }

    // Run all 5 volume converters, then clean up temp file
    const vtiPath = path.join(dirPath, 'volume.vti');
    const nrrdPath = path.join(dirPath, 'volume.nrrd');
    // .nii.gz because the file is gzipped: the extension is what tells 3D Slicer, FSL and the web
    // viewer to inflate it. The Unity reader sniffs the magic bytes and does not care either way.
    const niftiPath = path.join(dirPath, 'volume.nii.gz');
    const stlPath = path.join(dirPath, 'model.stl');
    const vtkLegacyPath = path.join(dirPath, 'volume.vtk');
    let vtiResult = null, nrrdResult = null, niftiResult = null, stlResult = null, vtkResult = null, mprResult = null;

    if (volume) {
        try {
            const { rows, columns, depth } = volume.dimensions;
            // Attached to every converter failure: the same message means different things at
            // 512x512x50 and 512x512x900, and "out of memory" is only actionable with the size.
            const geometry = {
                dimensions: `${columns} x ${rows} x ${depth}`,
                voxels: columns * rows * depth,
                spacingMm: volume.spacing.map(s => +Number(s).toFixed(4)).join(' x '),
                valueRange: `${volume.stats.min} .. ${volume.stats.max}`,
            };
            volumeGeometry = geometry;

            // Skipped files, blanked slices, an ignored second acquisition - collected during the
            // build and previously visible only in the server console.
            if (volume.notes?.length) warnings.push(...volume.notes);

            const runConverter = async (phase, outputPath, work) => {
                try {
                    await timer.run(phase, work);
                    return outputPath;
                } catch (error) {
                    record(errors, phase, error, {
                        file: path.basename(outputPath),
                        ...geometry,
                    });
                    return null;
                }
            };

            setProcessingStatus('Creating VTI file...');
            vtiResult = await runConverter('vti', vtiPath, () => convertToVti(volume, vtiPath));

            setProcessingStatus('Creating NRRD file...');
            nrrdResult = await runConverter('nrrd', nrrdPath, () => convertToNrrd(volume, nrrdPath));

            setProcessingStatus('Creating NIfTI file...');
            niftiResult = await runConverter('nifti', niftiPath, () => convertToNifti(volume, niftiPath));

            setProcessingStatus('Creating STL model...');
            stlResult = await runConverter('stl', stlPath, () => convertToStl(volume, stlPath));

            setProcessingStatus('Creating VTK file...');
            vtkResult = await runConverter('vtk', vtkLegacyPath, () => convertToVtk(volume, vtkLegacyPath));

            setProcessingStatus('Creating MPR slices...');
            const mprDir = path.join(dirPath, 'mpr');
            mprResult = await runConverter('mpr', mprDir, () => convertToMpr(volume, dirPath));
        } finally {
            volume.cleanup();
            volume = null;
        }
    }

    setProcessingStatus('');
    logMemory('processing-done');
    const timings = timer.report();

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
                mprPath: mprResult ? removePathBeforeUploads(path.join(mprResult, 'mpr_info.json')) : null,
                dicomInfo: result.dicomInfo
            });
        }
    }

    // Run MedGemma AI analysis on the middle slice (most representative)
    let aiAnalysis = null;
    if (processedFiles.length > 0) {
        setProcessingStatus('Running MedGemma AI analysis...');
        const midIdx = Math.floor(processedFiles.length / 2);
        const representative = processedFiles[midIdx];
        // jpgPath is server-relative and starts with a slash ("/uploads/..."), which path.resolve
        // treats as absolute - it discarded the "public" segment and produced a path that never
        // exists, so analyzeDicom bailed at its existsSync guard and no upload ever got analysed.
        const jpgAbsPath = path.join(PUBLIC_DIR, representative.jpgPath);
        aiAnalysis = await analyzeDicom(jpgAbsPath, representative.dicomInfo);
    }

    // Everything the browser needs to explain the outcome without reading the server log: what was
    // found, what came out, which stage each failure was in, and how long the work took.
    const outputs = {
        vti: !!vtiResult,
        nrrd: !!nrrdResult,
        nifti: !!niftiResult,
        stl: !!stlResult,
        vtk: !!vtkResult,
        mpr: !!mprResult,
    };

    const summary = {
        dicomFilesFound: dicomFiles.length,
        imagesConverted: processedFiles.length,
        imagesFailed: dicomFiles.length - processedFiles.length,
        volume: volumeGeometry,
        outputs,
        outputsMissing: Object.entries(outputs).filter(([, ok]) => !ok).map(([name]) => name),
        timings,
        aiAnalysis: aiAnalysis ? 'ran' : 'not available',
    };

    console.log(`[SUMMARY] ${summary.imagesConverted}/${summary.dicomFilesFound} images, ` +
        `outputs missing: ${summary.outputsMissing.join(', ') || 'none'}, ` +
        `${errors.length} error(s), ${warnings.length} warning(s)`);

    return { processedFiles, errors, warnings, summary, aiAnalysis };
}
