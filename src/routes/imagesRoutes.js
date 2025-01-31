const express = require('express');
const router = express.Router();
const imagesController = require('../controllers/imagesController');

// Route to get all images
router.get('/', imagesController.getAllImages);

// Route to view a specific image
router.get('/:imageName', imagesController.viewImage);

module.exports = router;