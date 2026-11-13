const PairingToken = require('../models/PairingToken');
const Chat = require('../models/Chat');
const User = require('../models/User');

// @desc    Generate a pairing code
// @route   POST /api/pairing/create
// @access  Private
exports.createToken = async (req, res) => {
  try {
    // Check if the user is already paired in any chat (limit to 1 pairing for this 2-person app)
    const existingChat = await Chat.findOne({ participants: req.user._id });
    if (existingChat) {
      return res.status(400).json({ message: 'You are already paired with another device.' });
    }

    // Delete any existing pairing tokens created by this user
    await PairingToken.deleteMany({ createdBy: req.user._id });

    // Generate a 6-digit token
    const token = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes from now

    const pairingToken = await PairingToken.create({
      token,
      createdBy: req.user._id,
      expiresAt,
    });

    res.status(201).json({
      token: pairingToken.token,
      expiresAt: pairingToken.expiresAt,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Consume pairing code & create chat pair
// @route   POST /api/pairing/consume
// @access  Private
exports.consumeToken = async (req, res) => {
  const { token } = req.body;

  if (!token) {
    return res.status(400).json({ message: 'Pairing token is required' });
  }

  try {
    const pairingToken = await PairingToken.findOne({ token, used: false });

    if (!pairingToken) {
      return res.status(404).json({ message: 'Invalid or expired pairing code' });
    }

    if (pairingToken.expiresAt < new Date()) {
      return res.status(400).json({ message: 'Pairing code has expired' });
    }

    const creatorId = pairingToken.createdBy;
    const consumerId = req.user._id;

    if (creatorId.toString() === consumerId.toString()) {
      return res.status(400).json({ message: 'You cannot pair with yourself' });
    }

    // Check if consumer is already paired
    const consumerChat = await Chat.findOne({ participants: consumerId });
    if (consumerChat) {
      return res.status(400).json({ message: 'You are already paired in another chat.' });
    }

    // Create the Chat room
    const newChat = await Chat.create({
      participants: [creatorId, consumerId],
      pairedAt: new Date(),
    });

    // Mark token as used
    pairingToken.used = true;
    await pairingToken.save();

    // Fetch the peer user information to return their public key
    const peerUser = await User.findById(creatorId).select('name email publicKey avatar status lastSeen');

    // Return the new chat and the peer user info (which contains their public key)
    res.status(201).json({
      chat: newChat,
      peer: peerUser,
    });

    // Also broadcast message over sockets if Socket.io is accessible
    const io = req.app.get('socketio');
    if (io) {
      // Notify creator that pairing is complete
      io.to(creatorId.toString()).emit('pairing:completed', {
        chat: newChat,
        peer: {
          _id: req.user._id,
          name: req.user.name,
          email: req.user.email,
          publicKey: req.user.publicKey,
          avatar: req.user.avatar,
          status: req.user.status,
          lastSeen: req.user.lastSeen,
        },
      });
    }
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Reset pairing (unpair / delete chats)
// @route   POST /api/pairing/reset
// @access  Private
exports.resetPairing = async (req, res) => {
  try {
    // Delete any chats this user is a participant of
    const chat = await Chat.findOne({ participants: req.user._id });
    if (chat) {
      // Delete all messages in the chat
      const Message = require('../models/Message');
      await Message.deleteMany({ chatId: chat._id });
      await Chat.deleteOne({ _id: chat._id });
      
      // Notify the other user via socket if they are online
      const io = req.app.get('socketio');
      if (io) {
        chat.participants.forEach(pId => {
          if (pId.toString() !== req.user._id.toString()) {
            io.to(pId.toString()).emit('pairing:reset');
          }
        });
      }
    }
    
    res.status(200).json({ message: 'Pairing reset successfully' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};
