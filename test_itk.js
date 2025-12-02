
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { readImageDicomFileSeriesNode } from '@itk-wasm/dicom';
import * as itkWasm from 'itk-wasm';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SAMPLE_DCM_PATH = path.join(__dirname, 'public/uploads/1764649500983_d20/1.2.840.113619.2.176.3596.10291748.6757.1444586996.84.dcm');
const TEMP_DIR = path.join(__dirname, 'test_itk_temp');

async function run() {
    try {
        // Initialize ITK-WASM
        console.log('Initializing ITK-WASM...');
        console.log('itkWasm keys:', Object.keys(itkWasm));
        if (itkWasm.ready) {
            await itkWasm.ready;
            console.log('ITK-WASM initialized');
        } else {
            console.log('itkWasm.ready is undefined');
        }

        if (!fs.existsSync(TEMP_DIR)) {
            fs.mkdirSync(TEMP_DIR);
        }
        
        // Copy sample file
        const destPath = path.join(TEMP_DIR, 'test.dcm');
        if (fs.existsSync(SAMPLE_DCM_PATH)) {
            fs.copyFileSync(SAMPLE_DCM_PATH, destPath);
            console.log(`Copied ${SAMPLE_DCM_PATH} to ${destPath}`);
        } else {
            console.error("Sample file not found!");
            return;
        }

        console.log('Reading DICOM series from:', TEMP_DIR);
        const image = await readImageDicomFileSeriesNode(TEMP_DIR);
        console.log('Success!', image.imageType);

    } catch (error) {
        console.error('Error:', error);
        console.error('Type:', typeof error);
    } finally {
        // Cleanup
        // fs.rmSync(TEMP_DIR, { recursive: true, force: true });
    }
}

run();
