const fs = require('fs');
const path = require('path');
const unzipper = require('unzipper');
const sharp = require('sharp');
const { exec } = require('child_process');

const processDICOMFiles = (zipFilePath, outputDir) => {
    const timestamp = Date.now();
    const timestampedDir = path.join(outputDir, `dicom_${timestamp}`);

    fs.mkdirSync(timestampedDir, { recursive: true });

    fs.createReadStream(zipFilePath)
        .pipe(unzipper.Extract({ path: timestampedDir }))
        .on('close', () => {
            fs.readdir(timestampedDir, (err, files) => {
                if (err) throw err;

                files.forEach(file => {
                    const oldPath = path.join(timestampedDir, file);
                    const newPath = path.join(timestampedDir, path.basename(file, path.extname(file)));

                    fs.renameSync(oldPath, newPath);

                    if (path.extname(file).toLowerCase() === '.dcm') {
                        convertDICOMToJPG(newPath);
                        convertDICOMToVTP(newPath, timestampedDir);
                    }
                });
            });
        });
};

const convertDICOMToJPG = (dicomFilePath) => {
    const jpgFilePath = dicomFilePath.replace(/\.dcm$/, '.jpg');
    sharp(dicomFilePath)
        .toFile(jpgFilePath, (err) => {
            if (err) throw err;
        });
};

const convertDICOMToVTP = (dicomFilePath, outputDir) => {
    const vtpFilePath = path.join(outputDir, path.basename(dicomFilePath, path.extname(dicomFilePath)) + '.vtp');
    exec(`vtkDICOMImageReader ${dicomFilePath} -o ${vtpFilePath}`, (err) => {
        if (err) throw err;
    });
};

module.exports = {
    processDICOMFiles,
    convertDICOMToJPG,
    convertDICOMToVTP
};