// filepath: /C:/dev/upload_dicom/src/routes/uploadRoutes.js
const express = require('express');
const uploadController = require('../controllers/uploadController');

const router = express.Router();

// Route for uploading DICOM files
router.post('/upload', uploadController.uploadFiles);

module.exports = router;