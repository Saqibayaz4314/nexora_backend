const express = require('express');
const router = express.Router();
const { createToken, consumeToken, resetPairing } = require('../controllers/pairing.controller');
const { protect } = require('../middleware/authMiddleware');

router.post('/create', protect, createToken);
router.post('/consume', protect, consumeToken);
router.post('/reset', protect, resetPairing);

module.exports = router;
