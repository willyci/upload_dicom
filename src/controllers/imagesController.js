const fs = require('fs');
const path = require('path');

const imagesController = {
    renderImagesPage: (req, res) => {
        const imagesDir = path.join(__dirname, '../../public/images');
        fs.readdir(imagesDir, (err, files) => {
            if (err) {
                return res.status(500).send('Error reading images directory');
            }
            const images = files.filter(file => /\.(jpg|jpeg|png|gif)$/.test(file));
            res.render('images', { images });
        });
    }
};

module.exports = imagesController;