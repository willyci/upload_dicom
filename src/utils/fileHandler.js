const fs = require('fs');
const path = require('path');
const unzipper = require('unzipper');

// Function to create a directory
const createDirectory = (dirPath) => {
    if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
    }
};

// Function to unzip files
const unzipFiles = (zipFilePath, outputDir) => {
    return fs.createReadStream(zipFilePath)
        .pipe(unzipper.Extract({ path: outputDir }));
};

// Function to rename files without extensions
const renameFilesWithoutExtension = (dirPath) => {
    fs.readdir(dirPath, (err, files) => {
        if (err) throw err;
        files.forEach(file => {
            const oldPath = path.join(dirPath, file);
            const newPath = path.join(dirPath, path.parse(file).name);
            fs.rename(oldPath, newPath, (err) => {
                if (err) throw err;
            });
        });
    });
};

// Function to delete a directory and its contents
const deleteDirectory = (dirPath) => {
    if (fs.existsSync(dirPath)) {
        fs.rmdirSync(dirPath, { recursive: true });
    }
};

module.exports = {
    createDirectory,
    unzipFiles,
    renameFilesWithoutExtension,
    deleteDirectory
};