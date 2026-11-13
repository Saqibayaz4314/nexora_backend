const express = require('express');
const router = express.Router();
const { getChats, getMessages, updateMessageStatusHttp } = require('../controllers/chat.controller');
const { protect } = require('../middleware/authMiddleware');

router.get('/', protect, getChats);
router.get('/:chatId/messages', protect, getMessages);
router.put('/messages/:messageId/status', protect, updateMessageStatusHttp);

module.exports = router;
