import express from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import unzipper from 'unzipper';
import { UPLOADS_DIR } from '../config.js';
import { processDirectory } from '../services/processor.js';
import { removePathBeforeUploads } from '../utils/paths.js';

const upload = multer({
    dest: UPLOADS_DIR,
    limits: { fileSize: 500 * 1024 * 1024 } // 500MB
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

router.post('/upload', upload.single('file'), async (req, res, next) => {
    try {
        if (!req.file) {
            return res.status(400).json({ success: false, message: 'No file uploaded' });
        }

        // Validate file extension
        if (!req.file.originalname.toLowerCase().endsWith('.zip')) {
            fs.unlinkSync(req.file.path);
            return res.status(400).json({ success: false, message: 'Only ZIP files are accepted' });
        }

        // Validate ZIP magic bytes
        if (!isValidZip(req.file.path)) {
            fs.unlinkSync(req.file.path);
            return res.status(400).json({ success: false, message: 'File is not a valid ZIP archive' });
        }

        const timestamp = Date.now();
        const folderName = `${timestamp}_${req.file.originalname.replace('.zip', '')}`;
        const extractPath = path.join(UPLOADS_DIR, folderName);

        await fs.promises.mkdir(extractPath, { recursive: true });

        // Extract ZIP file
        await new Promise((resolve, reject) => {
            const unzipStream = unzipper.Parse();
            fs.createReadStream(req.file.path)
                .pipe(unzipStream)
                .on('entry', (entry) => {
                    const fileName = path.basename(entry.path);
                    const writePath = path.join(extractPath, fileName);

                    if (entry.type === 'File') {
                        entry.pipe(fs.createWriteStream(writePath));
                    } else {
                        entry.autodrain();
                    }
                })
                .on('finish', resolve)
                .on('error', reject);
        });

        // Verify .dcm files exist
        const extractedFiles = await fs.promises.readdir(extractPath);
        const hasDcmFiles = extractedFiles.some(f => f.toLowerCase().endsWith('.dcm'));
        if (!hasDcmFiles) {
            await fs.promises.rm(extractPath, { recursive: true, force: true });
            fs.unlinkSync(req.file.path);
            return res.status(400).json({ success: false, message: 'ZIP contains no .dcm files' });
        }

        // Process extracted files
        const { processedFiles, errors } = await processDirectory(extractPath + '/');

        // Create JSON file
        const jsonData = JSON.stringify(processedFiles, null, 2);
        const jsonPath = path.join(extractPath + '/', 'dicom_info.json');
        await fs.promises.writeFile(jsonPath, jsonData);

        // Clean up the uploaded ZIP file
        fs.unlinkSync(req.file.path);

        res.json({
            success: true,
            folder: folderName,
            processedFiles: processedFiles,
            errors: errors.length > 0 ? errors : undefined,
            jsonPath: removePathBeforeUploads(jsonPath),
            vtiPaths: processedFiles.map(file => file.vtiPath),
            nrrdPaths: processedFiles.map(file => file.nrrdPath),
            niftiPaths: processedFiles.map(file => file.niftiPath),
            stlPaths: processedFiles.map(file => file.stlPath),
            vtkLegacyPaths: processedFiles.map(file => file.vtkLegacyPath)
        });
    } catch (error) {
        // Clean up temp file on error
        if (req.file && fs.existsSync(req.file.path)) {
            try { fs.unlinkSync(req.file.path); } catch {}
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

        async function findJsonFiles(dir) {
            const jsonFiles = [];
            const items = await fs.promises.readdir(dir, { withFileTypes: true });

            for (const item of items) {
                const fullPath = path.join(dir, item.name);

                if (item.isDirectory()) {
                    const nestedFiles = await findJsonFiles(fullPath);
                    jsonFiles.push(...nestedFiles);
                } else if (item.name === 'dicom_info.json') {
                    const vtiPath = path.join(path.dirname(fullPath), 'volume.vti');
                    const nrrdPath = path.join(path.dirname(fullPath), 'volume.nrrd');
                    jsonFiles.push({
                        jsonPath: fullPath,
                        vtiPath: fs.existsSync(vtiPath) ? vtiPath : null,
                        nrrdPath: fs.existsSync(nrrdPath) ? nrrdPath : null
                    });
                }
            }

            return jsonFiles;
        }

        const jsonFiles = await findJsonFiles(UPLOADS_DIR);

        const normalizedPaths = jsonFiles.map((filePath, index) => ({
            index: index + 1,
            path: removePathBeforeUploads(filePath.jsonPath.replace(/\\/g, '/')),
            vtiPath: removePathBeforeUploads(filePath.jsonPath.replace(/\\/g, '/').replace(/dicom_info.json/, 'volume.vti')),
            nrrdPath: removePathBeforeUploads(filePath.jsonPath.replace(/\\/g, '/').replace(/dicom_info.json/, 'volume.nrrd')),
            niftiPath: removePathBeforeUploads(filePath.jsonPath.replace(/\\/g, '/').replace(/dicom_info.json/, 'volume.nii')),
            stlPath: removePathBeforeUploads(filePath.jsonPath.replace(/\\/g, '/').replace(/dicom_info.json/, 'model.stl')),
            vtkLegacyPath: removePathBeforeUploads(filePath.jsonPath.replace(/\\/g, '/').replace(/dicom_info.json/, 'volume.vtk'))
        }));

        const indexPath = path.join(UPLOADS_DIR, 'index.json');
        await fs.promises.writeFile(
            indexPath,
            JSON.stringify({ folders: normalizedPaths }, null, 2)
        );

        res.json({
            folders: normalizedPaths,
            indexPath: removePathBeforeUploads(indexPath)
        });
    } catch (error) {
        console.error('Error listing uploads:', error);
        res.status(500).json({ error: 'Error listing uploads' });
    }
});

export default router;
