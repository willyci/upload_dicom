import fs from 'fs';
import { DicomMetaDictionary, DicomMessage } from './dicomHelpers.js';

export function showDicomInfo(inputPath) {
    try {
        const dicomFileBuffer = fs.readFileSync(inputPath);
        const dicomData = DicomMessage.readFile(dicomFileBuffer.buffer);
        const dataset = DicomMetaDictionary.naturalizeDataset(dicomData.dict);

        const transferSyntax = dataset.TransferSyntaxUID;
        if (transferSyntax) {
            const uncompressed = [
                '1.2.840.10008.1.2',
                '1.2.840.10008.1.2.1',
                '1.2.840.10008.1.2.2'
            ];
            if (!uncompressed.includes(transferSyntax)) {
                console.log(`Transfer Syntax ${transferSyntax} uses compressed pixel data`);
            }
        }

        return dataset;
    } catch (error) {
        console.error('Error reading DICOM info:', error.message);
        return null;
    }
}
