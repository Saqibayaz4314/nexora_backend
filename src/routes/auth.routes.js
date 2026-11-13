const express = require('express');
const router = express.Router();
const { register, login, refresh, getMe, updatePublicKey } = require('../controllers/auth.controller');
const { protect } = require('../middleware/authMiddleware');

router.post('/register', register);
router.post('/login', login);
router.post('/refresh', refresh);
router.get('/me', protect, getMe);
router.put('/public-key', protect, updatePublicKey);

module.exports = router;
