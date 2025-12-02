
import fs from 'fs';
import path from 'path';
import http from 'http';
import AdmZip from 'adm-zip';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SAMPLE_DCM_PATH = path.join(__dirname, 'public/uploads/1764649500983_d20/1.2.840.113619.2.176.3596.10291748.6757.1444586996.84.dcm');
const ZIP_PATH = path.join(__dirname, 'test_upload.zip');

async function createTestZip() {
    const zip = new AdmZip();
    if (fs.existsSync(SAMPLE_DCM_PATH)) {
        zip.addLocalFile(SAMPLE_DCM_PATH);
    } else {
        // Create a dummy file if sample not found
        zip.addFile("test.dcm", Buffer.from("dummy dicom content"));
        console.warn("Sample DICOM not found, using dummy content.");
    }
    zip.writeZip(ZIP_PATH);
    console.log(`Created test zip at ${ZIP_PATH}`);
}

function uploadZip() {
    const boundary = '----WebKitFormBoundary7MA4YWxkTrZu0gW';
    const postDataStart = [
        `--${boundary}`,
        'Content-Disposition: form-data; name="file"; filename="test_upload.zip"',
        'Content-Type: application/zip',
        '',
        ''
    ].join('\r\n');
    
    const postDataEnd = `\r\n--${boundary}--`;
    
    const fileContent = fs.readFileSync(ZIP_PATH);
    
    const options = {
        hostname: 'localhost',
        port: 3001,
        path: '/upload',
        method: 'POST',
        headers: {
            'Content-Type': `multipart/form-data; boundary=${boundary}`,
            'Content-Length': Buffer.byteLength(postDataStart) + fileContent.length + Buffer.byteLength(postDataEnd)
        }
    };

    const req = http.request(options, (res) => {
        console.log(`STATUS: ${res.statusCode}`);
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
            console.log(`BODY: ${chunk}`);
        });
        res.on('end', () => {
            console.log('No more data in response.');
        });
    });

    req.on('error', (e) => {
        console.error(`problem with request: ${e.message}`);
    });

    req.write(postDataStart);
    req.write(fileContent);
    req.write(postDataEnd);
    req.end();
}

async function run() {
    await createTestZip();
    uploadZip();
}

run();
