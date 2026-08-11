import express from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import unzipper from 'unzipper';
import { UPLOADS_DIR } from '../config.js';
import { processDirectory } from '../services/processor.js';
import { removePathBeforeUploads } from '../utils/paths.js';
import { findDicomFiles, isDicomFile } from '../utils/dicomFiles.js';
import { getProcessingStatus } from '../utils/progress.js';

const upload = multer({
    dest: UPLOADS_DIR,
    limits: { fileSize: 2 * 1024 * 1024 * 1024 } // 2GB per file
});

const router = express.Router();

// Validate ZIP magic bytes (PK\x03\x04)
function isValidZip(filePath) {
    try {
        const fd = fs.openSync(filePath, 'r');
        const buf = Buffer.alloc(4);
        fs.readSync(fd, buf, 0, 4, 0);
        fs.closeSync(fd);
        return buf[0] === 0x50 && buf[1] === 0x4B && buf[2] === 0x03 && buf[3] === 0x04;
    } catch {
        return false;
    }
}

/**
 * Scan the uploads tree and (re)write index.json — the catalog every viewer reads, including the
 * Quest app, which has no other way to discover a dataset.
 *
 * Returns the folder list. Called both by /list-uploads and at the end of an upload, so a new
 * dataset appears without anyone having to open the web listing first.
 */
export async function buildUploadsIndex() {
    if (!fs.existsSync(UPLOADS_DIR)) {
        return [];
    }

    async function findJsonFiles(dir) {
        const jsonFiles = [];
        const items = await fs.promises.readdir(dir, { withFileTypes: true });

        for (const item of items) {
            const fullPath = path.join(dir, item.name);

            if (item.isDirectory()) {
                const nestedFiles = await findJsonFiles(fullPath);
                jsonFiles.push(...nestedFiles);
            } else if (item.name === 'dicom_info.json') {
                const mprInfoPath = path.join(path.dirname(fullPath), 'mpr', 'mpr_info.json');
                jsonFiles.push({
                    jsonPath: fullPath,
                    mprInfoPath: fs.existsSync(mprInfoPath) ? mprInfoPath : null
                });
            }
        }

        return jsonFiles;
    }

    const jsonFiles = await findJsonFiles(UPLOADS_DIR);

    const folders = jsonFiles.map((filePath, index) => {
        const folder = path.dirname(filePath.jsonPath);

        // Existence-checked, and the candidates are tried in order. This used to be blind string
        // substitution, which advertised files that might not exist - and a missing niftiPath is
        // expensive rather than merely wrong: the Quest app reads a null as "no NIfTI" and falls
        // back to downloading the DICOM series one slice at a time.
        const sibling = (...names) => {
            for (const name of names) {
                const candidate = path.join(folder, name);
                if (fs.existsSync(candidate))
                    return removePathBeforeUploads(candidate.replace(/\\/g, '/'));
            }
            return null;
        };

        return {
            index: index + 1,
            path: removePathBeforeUploads(filePath.jsonPath.replace(/\\/g, '/')),
            vtiPath: sibling('volume.vti'),
            nrrdPath: sibling('volume.nrrd'),
            // Newer uploads are gzipped; older ones on disk are not, and both must keep working.
            niftiPath: sibling('volume.nii.gz', 'volume.nii'),
            stlPath: sibling('model.stl'),
            vtkLegacyPath: sibling('volume.vtk'),
            mprPath: filePath.mprInfoPath ? removePathBeforeUploads(filePath.mprInfoPath.replace(/\\/g, '/')) : null
        };
    });

    await fs.promises.writeFile(
        path.join(UPLOADS_DIR, 'index.json'),
        JSON.stringify({ folders }, null, 2)
    );

    return folders;
}

const uploadMiddleware = upload.array('files', 200);

const handleUpload = (req, res, next) => {
    uploadMiddleware(req, res, (err) => {
        if (err instanceof multer.MulterError) {
            if (err.code === 'LIMIT_FILE_SIZE') {
                return res.status(400).json({ 
                    success: false, 
                    message: 'File is too large. Maximum size is 2GB.' 
                });
            }
            return res.status(400).json({ 
                success: false, 
                message: `Upload error: ${err.message}` 
            });
        } else if (err) {
            return res.status(500).json({ 
                success: false, 
                message: `Unknown upload error: ${err.message}` 
            });
        }
        next();
    });
};

router.post('/upload', handleUpload, async (req, res, next) => {
    // Large DICOM sets can take minutes to process — disable response timeout
    req.setTimeout(0);
    res.setTimeout(0);

    const tempFiles = []; // track temp files for cleanup
    try {
        if (!req.files || req.files.length === 0) {
            return res.status(400).json({ success: false, message: 'No files uploaded' });
        }

        // Track temp files for cleanup
        for (const f of req.files) {
            tempFiles.push(f.path);
        }

        const timestamp = Date.now();
        // Build folder name from first file's original name. The name is client-supplied, so strip
        // anything that could climb out of the uploads directory or confuse a path.
        const firstName = req.files[0].originalname
            .replace(/\.zip$/i, '')
            .replace(/\.dcm$/i, '')
            .replace(/[^\w.\-]+/g, '_')
            .replace(/^\.+/, '')
            || 'upload';
        const suffix = req.files.length > 1 ? `_and_${req.files.length - 1}_more` : '';
        const folderName = `${timestamp}_${firstName}${suffix}`;
        const extractPath = path.join(UPLOADS_DIR, folderName);

        await fs.promises.mkdir(extractPath, { recursive: true });

        const skipped = [];

        // Process each uploaded file
        for (const file of req.files) {
            if (isValidZip(file.path)) {
                // Extract ZIP preserving relative paths
                await new Promise((resolve, reject) => {
                    const unzipStream = unzipper.Parse();
                    let fileCount = 0;
                    let totalSize = 0;
                    // Limit total extracted size (e.g., 512MB) and file count to prevent OOM
                    const MAX_EXTRACTED_SIZE = 512 * 1024 * 1024; 
                    const MAX_FILE_COUNT = 1000;
                    let aborted = false;

                    fs.createReadStream(file.path)
                        .pipe(unzipStream)
                        .on('entry', async (entry) => {
                            if (aborted) {
                                entry.autodrain();
                                return;
                            }

                            // Skip directories and hidden/macOS metadata files
                            if (entry.type !== 'File' || entry.path.startsWith('__MACOSX')) {
                                entry.autodrain();
                                return;
                            }

                            fileCount++;
                            // entry.vars.uncompressedSize might be available, otherwise we count bytes written
                            // Note: uncompressedSize can be 0 or undefined in some zip formats until read
                            // We will start by assuming optimistic check if available, 
                            // but strictly we should check bytes written if we want to be safe against zip bombs.
                            // For simplicity/speed on standard zips, we check declared size if present.
                            const estimatedSize = entry.vars.uncompressedSize || 0;
                            
                            if (fileCount > MAX_FILE_COUNT) {
                                aborted = true;
                                unzipStream.destroy();
                                reject(new Error(`Too many files in ZIP. Limit is ${MAX_FILE_COUNT}.`));
                                return;
                            }
                            
                            if (totalSize + estimatedSize > MAX_EXTRACTED_SIZE) {
                                aborted = true;
                                unzipStream.destroy();
                                reject(new Error(`Total extracted size exceeds limit of ${MAX_EXTRACTED_SIZE / (1024*1024)}MB.`));
                                return;
                            }

                            // Preserve relative path structure, but never outside the upload's own
                            // folder: entry names come from the archive, and "../../x" would
                            // otherwise write wherever it liked (zip-slip).
                            const relativePath = entry.path;
                            const writePath = path.resolve(extractPath, relativePath);

                            if (writePath !== extractPath && !writePath.startsWith(extractPath + path.sep)) {
                                console.warn(`Skipping ZIP entry that escapes the upload folder: ${relativePath}`);
                                entry.autodrain();
                                return;
                            }

                            // Ensure parent directory exists
                            await fs.promises.mkdir(path.dirname(writePath), { recursive: true });
                            
                            const writeStream = fs.createWriteStream(writePath);
                            let entrySize = 0;
                            
                            entry.on('data', (chunk) => {
                                entrySize += chunk.length;
                                totalSize += chunk.length;
                                if (!aborted && totalSize > MAX_EXTRACTED_SIZE) {
                                    aborted = true;
                                    writeStream.destroy();
                                    unzipStream.destroy();
                                    reject(new Error(`Total extracted size exceeds limit of ${MAX_EXTRACTED_SIZE / (1024*1024)}MB.`));
                                }
                            });

                            entry.pipe(writeStream);
                        })
                        .on('finish', () => {
                            if (!aborted) resolve();
                        })
                        .on('error', (err) => {
                            if (!aborted) reject(err);
                        });
                });
            } else if (isDicomFile(file.path, file.originalname)) {
                // A .dcm file, or an extensionless one whose bytes say DICOM. Judged on
                // originalname for the extension and on file.path for the magic bytes, because
                // multer stores the upload under a generated name with no extension of its own.
                const destPath = path.join(extractPath, file.originalname);
                await fs.promises.rename(file.path, destPath);
                // Remove from temp cleanup list since it was moved
                const idx = tempFiles.indexOf(file.path);
                if (idx !== -1) tempFiles.splice(idx, 1);
            } else {
                // Skip non-ZIP, non-DICOM files
                skipped.push(file.originalname);
            }
        }

        // Recursively find every DICOM file, extensionless ones included
        const dcmFiles = await findDicomFiles(extractPath);

        if (dcmFiles.length === 0) {
            await fs.promises.rm(extractPath, { recursive: true, force: true });
            // Clean up temp files
            for (const tmp of tempFiles) {
                try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch {}
            }
            const msg = skipped.length > 0
                ? `No DICOM files found. Skipped non-DICOM files: ${skipped.join(', ')}`
                : 'No DICOM files found in the uploaded files';
            return res.status(400).json({ success: false, message: msg });
        }

        // Process extracted files
        const { processedFiles, errors, aiAnalysis } = await processDirectory(extractPath + '/');

        // Create JSON file — include AI analysis at top level
        const jsonOutput = { files: processedFiles };
        if (aiAnalysis) jsonOutput.aiAnalysis = aiAnalysis;
        const jsonData = JSON.stringify(jsonOutput, null, 2);
        const jsonPath = path.join(extractPath + '/', 'dicom_info.json');
        await fs.promises.writeFile(jsonPath, jsonData);

        // Refresh the catalog now rather than waiting for someone to load the web listing, which
        // is the only thing that used to write it - until then the new dataset was invisible to
        // the Quest app.
        try {
            await buildUploadsIndex();
        } catch (indexError) {
            console.error('Failed to update index.json:', indexError.message);
            errors.push({ converter: 'index', error: indexError.message });
        }

        // Clean up temp files
        for (const tmp of tempFiles) {
            try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch {}
        }

        const response = {
            success: true,
            folder: folderName,
            processedFiles: processedFiles,
            errors: errors.length > 0 ? errors : undefined,
            jsonPath: removePathBeforeUploads(jsonPath),
            vtiPaths: processedFiles.map(file => file.vtiPath),
            nrrdPaths: processedFiles.map(file => file.nrrdPath),
            niftiPaths: processedFiles.map(file => file.niftiPath),
            stlPaths: processedFiles.map(file => file.stlPath),
            vtkLegacyPaths: processedFiles.map(file => file.vtkLegacyPath),
            mprPaths: processedFiles.map(file => file.mprPath)
        };

        if (skipped.length > 0) {
            response.skipped = skipped;
        }

        res.json(response);
    } catch (error) {
        // Clean up temp files on error
        for (const tmp of tempFiles) {
            try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch {}
        }
        console.error('Upload error:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

router.delete('/delete-upload', express.json(), async (req, res) => {
    try {
        const { folderPath } = req.body;

        if (!folderPath) {
            return res.status(400).json({ success: false, message: 'Folder path is required' });
        }

        const folderName = folderPath.endsWith('.json')
            ? path.basename(path.dirname(folderPath))
            : path.basename(folderPath);

        const absolutePath = path.join(UPLOADS_DIR, folderName);

        // Security check
        if (!absolutePath.startsWith(UPLOADS_DIR)) {
            return res.status(403).json({ success: false, message: 'Invalid path' });
        }

        try {
            await fs.promises.access(absolutePath);
        } catch {
            return res.status(404).json({ success: false, message: 'Folder not found' });
        }

        await fs.promises.rm(absolutePath, { recursive: true, force: true });

        res.json({ success: true, message: 'Folder deleted successfully' });
    } catch (error) {
        console.error('Delete error:', error);
        res.status(500).json({ success: false, message: error.message || 'Failed to delete folder' });
    }
});

router.get('/list-uploads', async (req, res) => {
    try {
        if (!fs.existsSync(UPLOADS_DIR)) {
            return res.json({ jsonFiles: [] });
        }

        const folders = await buildUploadsIndex();

        res.json({
            folders,
            indexPath: removePathBeforeUploads(path.join(UPLOADS_DIR, 'index.json'))
        });
    } catch (error) {
        console.error('Error listing uploads:', error);
        res.status(500).json({ error: 'Error listing uploads' });
    }
});

router.get('/processing-status', (req, res) => {
    res.json({ status: getProcessingStatus() });
});

export default router;
