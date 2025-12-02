
const path = "/uploads/1733116499123_test_dicom_info.json"; // Simulating what I think is happening, wait.
// Actually the server returns /uploads/TIMESTAMP_NAME/dicom_info.json
const path1 = "/uploads/1733116499123_test/dicom_info.json";

function parseOld(folderPath) {
    const folderName = folderPath.split('/').pop().replace('.json', '').split('_')[1];
    const timestamp = folderPath.split('/').pop().split('_')[0];
    return { folderName, timestamp };
}

function parseNew(folderPath) {
    const parts = folderPath.split('/');
    const dirName = parts[parts.length - 2];
    const folderName = dirName.split('_').slice(1).join('_'); // Handle names with underscores
    const timestamp = dirName.split('_')[0];
    return { folderName, timestamp, dirName };
}

console.log("Old parsing:", parseOld(path1));
console.log("New parsing:", parseNew(path1));
