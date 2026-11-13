const express = require('express');
const router = express.Router();
const { getUploadUrl, mockUpload } = require('../controllers/media.controller');
const { protect } = require('../middleware/authMiddleware');

router.post('/upload-url', protect, getUploadUrl);

// Put route for the mock binary upload (imitates standard direct PUT to S3)
router.put('/mock-upload/:fileName', mockUpload);

module.exports = router;
