const path = require('path');
const fs = require('fs');

exports.renderViewer = (req, res) => {
    const vtpFile = req.query.file;
    const filePath = path.join(__dirname, '../../public/vtp', vtpFile);

    if (fs.existsSync(filePath)) {
        res.sendFile(filePath);
    } else {
        res.status(404).send('File not found');
    }
};