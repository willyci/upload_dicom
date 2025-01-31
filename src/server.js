const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const unzipper = require('unzipper');
const dicom = require('dicom-parser');
const sharp = require('sharp');
const { promisify } = require('util');
const mkdir = promisify(fs.mkdir);

const app = express();
const upload = multer({ dest: 'uploads/' });

// Serve static files
app.use(express.static('public'));

// Handle file upload
app.post('/upload', upload.single('file'), async (req, res) => {
    try {
        if (!req.file) {
            throw new Error('No file uploaded');
        }

        // Create timestamp-based folder name
        const timestamp = Date.now();
        const folderName = `${timestamp}_${req.file.originalname.replace('.zip', '')}`;
        const extractPath = path.join(__dirname, 'uploads', folderName);
        
        // Create the directory
        await mkdir(extractPath, { recursive: true });

        // Extract ZIP file
        await fs.createReadStream(req.file.path)
            .pipe(unzipper.Extract({ path: extractPath }))
            .promise();

        // Process extracted files
        const files = await processDirectory(extractPath);

        // Clean up the uploaded ZIP file
        fs.unlinkSync(req.file.path);

        res.json({
            success: true,
            folder: folderName,
            processedFiles: files.length
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            message: error.message
        });
    }
});

async function processDirectory(dirPath) {
    const files = await fs.promises.readdir(dirPath);
    const processedFiles = [];

    for (const file of files) {
        const filePath = path.join(dirPath, file);
        const stats = await fs.promises.stat(filePath);

        if (stats.isFile()) {
            try {
                // Add .dcm extension if no extension exists
                if (!path.extname(file)) {
                    const newPath = `${filePath}.dcm`;
                    await fs.promises.rename(filePath, newPath);
                    processedFiles.push(newPath);
                }

                // Convert to JPG
                await convertToJpg(filePath, `${filePath}.jpg`);
            } catch (error) {
                console.error(`Error processing file ${file}:`, error);
            }
        }
    }

    return processedFiles;
}

async function convertToJpg(inputPath, outputPath) {
    try {
        // Read DICOM file
        const dicomData = await fs.promises.readFile(inputPath);
        const dataSet = dicom.parseDicom(dicomData);

        // Extract pixel data
        const pixelDataElement = dataSet.elements.x7FE00010;
        const width = dataSet.uint16('x00280010');
        const height = dataSet.uint16('x00280011');
        const bitsAllocated = dataSet.uint16('x00280100');
        const samplesPerPixel = dataSet.uint16('x00280002') || 1;
        const pixelRepresentation = dataSet.uint16('x00280103') || 0;

        if (!pixelDataElement) {
            throw new Error('No pixel data found in DICOM file');
        }

        // Extract raw pixel data
        let pixelData = new Uint8Array(pixelDataElement.length);
        for (let i = 0; i < pixelDataElement.length; i++) {
            pixelData[i] = dataSet.byteArray[pixelDataElement.dataOffset + i];
        }

        // Handle different bit allocations
        if (bitsAllocated === 16) {
            // Convert 16-bit to 8-bit
            const pixels16 = new Uint16Array(pixelData.buffer);
            pixelData = new Uint8Array(pixels16.length);
            
            // Find the maximum value for normalization
            let maxVal = 0;
            for (let i = 0; i < pixels16.length; i++) {
                if (pixels16[i] > maxVal) maxVal = pixels16[i];
            }
            
            // Normalize to 8-bit
            for (let i = 0; i < pixels16.length; i++) {
                pixelData[i] = Math.floor((pixels16[i] / maxVal) * 255);
            }
        }

        // Convert to JPG using sharp
        await sharp(Buffer.from(pixelData), {
            raw: {
                width: width,
                height: height,
                channels: samplesPerPixel
            }
        })
        .jpeg()
        .toFile(outputPath);

    } catch (error) {
        console.error(`Error converting ${inputPath} to JPG:`, error);
        throw error;
    }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});