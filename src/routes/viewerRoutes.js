const express = require('express');
const router = express.Router();
const viewerController = require('../controllers/viewerController');

// Route to render the viewer page
router.get('/:filename', viewerController.renderViewer);

// Route to serve VTP files
router.get('/files/:filename', viewerController.serveVTPFile);

module.exports = router;