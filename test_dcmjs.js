
import * as dcmjs from 'dcmjs';

console.log('dcmjs keys:', Object.keys(dcmjs));
if (dcmjs.data) {
    console.log('dcmjs.data keys:', Object.keys(dcmjs.data));
    if (dcmjs.data.DicomMessage) {
        console.log('DicomMessage found');
        console.log('DicomMessage keys:', Object.keys(dcmjs.data.DicomMessage));
        console.log('typeof DicomMessage.readFile:', typeof dcmjs.data.DicomMessage.readFile);
        try {
            const dummyBuffer = new ArrayBuffer(100);
            // dcmjs.data.DicomMessage.readFile(dummyBuffer);
        } catch (e) {
            console.log('Error calling readFile:', e.message);
        }
    } else {
        console.log('DicomMessage NOT found in dcmjs.data');
    }
} else {
    console.log('dcmjs.data NOT found');
}

// Check default export
if (dcmjs.default) {
    console.log('dcmjs.default keys:', Object.keys(dcmjs.default));
    if (dcmjs.default.data) {
        console.log('dcmjs.default.data keys:', Object.keys(dcmjs.default.data));
    }
}
