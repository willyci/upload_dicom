import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const FILE_PATH = path.join(__dirname, 'large_test_file.bin');
const UPLOAD_URL = 'http://localhost:3000/upload';

async function uploadFile() {
    console.log(`Starting upload of ${FILE_PATH} to ${UPLOAD_URL}...`);
    
    if (!fs.existsSync(FILE_PATH)) {
        // Create the file if it doesn't exist
        console.log('Creating large test file...');
        const file = fs.openSync(FILE_PATH, 'w');
        const buffer = Buffer.alloc(1024 * 1024 * 10); // 10MB chunk
        for (let i = 0; i < 1; i++) { // 10MB total
            fs.writeSync(file, buffer);
        }
        fs.closeSync(file);
    }

    const stat = fs.statSync(FILE_PATH);
    const fileSizeInMB = stat.size / (1024 * 1024);
    console.log(`File size: ${fileSizeInMB.toFixed(2)} MB`);

    const fileBuffer = fs.readFileSync('test_payload.zip');
    const blob = new Blob([fileBuffer]);
    const formData = new FormData();
    formData.append('files', blob, 'test_payload.zip');

    try {
        const response = await fetch(UPLOAD_URL, {
            method: 'POST',
            body: formData,
        });

        console.log(`Response Status: ${response.status}`);
        const text = await response.text();
        console.log(`Response Body: ${text}`);

        if (response.ok) {
            console.log('Upload successful!');
            return true;
        } else {
            console.log('Upload failed!');
            return false;
        }
    } catch (error) {
        console.error('Upload error:', error);
        return false;
    }
}

uploadFile();
