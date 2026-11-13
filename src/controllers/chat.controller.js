const Chat = require('../models/Chat');
const Message = require('../models/Message');
const User = require('../models/User');

// @desc    Get user chats
// @route   GET /api/chats
// @access  Private
exports.getChats = async (req, res) => {
  try {
    const chats = await Chat.find({
      participants: req.user._id,
    })
      .populate('participants', 'name email publicKey avatar status lastSeen')
      .sort({ updatedAt: -1 });

    res.json(chats);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Get chat message history
// @route   GET /api/chats/:chatId/messages
// @access  Private
exports.getMessages = async (req, res) => {
  const { chatId } = req.params;

  try {
    // Verify user is participant in the chat
    const chat = await Chat.findOne({
      _id: chatId,
      participants: req.user._id,
    });

    if (!chat) {
      return res.status(403).json({ message: 'Not authorized to view this chat' });
    }

    const messages = await Message.find({ chatId })
      .sort({ createdAt: 1 })
      .limit(100); // paginate in production if needed

    res.json(messages);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Update message status (delivered / seen) via HTTP
// @route   PUT /api/chats/messages/:messageId/status
// @access  Private
exports.updateMessageStatusHttp = async (req, res) => {
  const { status } = req.body; // 'delivered' or 'seen'
  const { messageId } = req.params;

  try {
    const message = await Message.findById(messageId);
    if (!message) {
      return res.status(404).json({ message: 'Message not found' });
    }

    let updated = false;
    if (status === 'seen' && message.status !== 'seen') {
      message.status = 'seen';
      updated = true;
    } else if (status === 'delivered' && message.status === 'sent') {
      message.status = 'delivered';
      updated = true;
    }

    if (updated) {
      await message.save();
      const io = req.app.get('socketio');
      if (io) {
        io.to(message.chatId.toString()).emit('message:status:updated', {
          messageId: message._id,
          chatId: message.chatId,
          status: message.status,
        });
      }
    }

    res.json({ messageId: message._id, status: message.status });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};
