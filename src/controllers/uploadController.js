const multer = require('multer');
const path = require('path');
const fs = require('fs');
const unzipper = require('unzipper');
const { processDICOMFiles, convertToJPG, convertToVTP } = require('../utils/dicomProcessor');
const { createDirectory, renameFiles } = require('../utils/fileHandler');

const storage = multer.memoryStorage();
const upload = multer({ storage: storage });

exports.uploadFiles = (req, res) => {
    upload.single('dicomZip')(req, res, async (err) => {
        if (err) {
            return res.status(400).send('Error uploading file.');
        }

        const timestamp = Date.now();
        const uploadDir = path.join(__dirname, `../../uploads/${timestamp}`);
        
        try {
            await createDirectory(uploadDir);
            const zipBuffer = req.file.buffer;

            // Unzip the contents
            await unzipper.Open.buffer(zipBuffer)
                .then(async (directory) => {
                    for (const file of directory.files) {
                        const filePath = path.join(uploadDir, file.path);
                        await file.stream.pipe(fs.createWriteStream(filePath));
                    }
                });

            // Rename files and process DICOM files
            const renamedFiles = await renameFiles(uploadDir);
            await convertToJPG(renamedFiles);
            await convertToVTP(renamedFiles);

            res.status(200).send('Files uploaded and processed successfully.');
        } catch (error) {
            console.error(error);
            res.status(500).send('Error processing files.');
        }
    });
};