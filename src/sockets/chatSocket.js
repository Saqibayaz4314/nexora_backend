const Message = require('../models/Message');
const Chat = require('../models/Chat');

module.exports = (io, socket) => {
  // Handle joining chat room
  socket.on('chat:join', (chatId) => {
    socket.join(chatId.toString());
    console.log(`Socket ${socket.id} joined chat room ${chatId}`);
  });

  // Handle message sending
  socket.on('message:send', async (data) => {
    const { chatId, receiverId, type, ciphertext, nonce, authTag, mediaMeta, replyTo } = data;
    const senderId = socket.user._id;

    try {
      // Validate chat
      const chat = await Chat.findOne({
        _id: chatId,
        participants: senderId,
      });

      if (!chat) {
        return socket.emit('error', { message: 'Chat room not found or unauthorized' });
      }

      // Save to database
      const message = await Message.create({
        chatId,
        sender: senderId,
        receiver: receiverId,
        type: type || 'text',
        ciphertext,
        nonce,
        authTag,
        mediaMeta,
        status: 'sent',
        replyTo,
      });

      // Update last message in Chat
      chat.lastMessage = {
        ciphertext,
        sender: senderId,
        timestamp: message.createdAt,
      };
      await chat.save();

      // Emit to room (both sender and receiver)
      io.to(chatId.toString()).emit('message:receive', message);
    } catch (error) {
      console.error('Error sending message via socket:', error);
      socket.emit('error', { message: 'Failed to send message' });
    }
  });

  // Handle message deletion
  socket.on('message:delete', async (data) => {
    const { messageId } = data;
    const userId = socket.user._id;

    try {
      const message = await Message.findById(messageId);
      if (!message) {
        return socket.emit('error', { message: 'Message not found' });
      }

      // Check authorization (only sender can delete the message for everyone)
      if (message.sender.toString() !== userId.toString()) {
        return socket.emit('error', { message: 'Unauthorized to delete this message' });
      }

      const chatId = message.chatId;
      await Message.deleteOne({ _id: messageId });

      // Broadcast delete event to room
      io.to(chatId.toString()).emit('message:deleted', {
        messageId,
        chatId,
      });
    } catch (error) {
      console.error('Error deleting message:', error);
      socket.emit('error', { message: 'Failed to delete message' });
    }
  });

  // Handle message editing
  socket.on('message:edit', async (data) => {
    const { messageId, ciphertext, nonce, authTag } = data;
    const senderId = socket.user._id;

    try {
      const message = await Message.findById(messageId);
      if (!message) {
        return socket.emit('error', { message: 'Message not found' });
      }

      if (message.sender.toString() !== senderId.toString()) {
        return socket.emit('error', { message: 'Unauthorized to edit this message' });
      }

      message.ciphertext = ciphertext;
      message.nonce = nonce;
      message.authTag = authTag;
      message.edited = true;
      message.editedAt = new Date();
      await message.save();

      // Broadcast edit event
      io.to(message.chatId.toString()).emit('message:edited', {
        messageId: message._id,
        chatId: message.chatId,
        ciphertext: message.ciphertext,
        nonce: message.nonce,
        authTag: message.authTag,
        edited: message.edited,
        editedAt: message.editedAt,
      });
    } catch (error) {
      console.error('Error editing message via socket:', error);
      socket.emit('error', { message: 'Failed to edit message' });
    }
  });

  // Handle message reaction adding/updating
  socket.on('message:react', async (data) => {
    const { messageId, emoji, ciphertext_optional } = data;
    const userId = socket.user._id;

    try {
      const message = await Message.findById(messageId);
      if (!message) {
        return socket.emit('error', { message: 'Message not found' });
      }

      // Check if user has already reacted
      const existingReactionIndex = message.reactions.findIndex(
        (r) => r.userId.toString() === userId.toString()
      );

      if (existingReactionIndex > -1) {
        // Update reaction
        message.reactions[existingReactionIndex].emoji = emoji;
        if (ciphertext_optional) {
          message.reactions[existingReactionIndex].ciphertext_optional = ciphertext_optional;
        }
      } else {
        // Add new reaction
        message.reactions.push({
          userId,
          emoji,
          ciphertext_optional,
        });
      }

      await message.save();

      // Broadcast reaction event to chat room
      io.to(message.chatId.toString()).emit('message:reacted', {
        messageId: message._id,
        chatId: message.chatId,
        reactions: message.reactions,
      });
    } catch (error) {
      console.error('Error adding reaction via socket:', error);
      socket.emit('error', { message: 'Failed to add reaction' });
    }
  });

  // Handle message reaction removal
  socket.on('message:react:remove', async (data) => {
    const { messageId } = data;
    const userId = socket.user._id;

    try {
      const message = await Message.findById(messageId);
      if (!message) {
        return socket.emit('error', { message: 'Message not found' });
      }

      message.reactions = message.reactions.filter(
        (r) => r.userId.toString() !== userId.toString()
      );

      await message.save();

      // Broadcast updated reactions
      io.to(message.chatId.toString()).emit('message:reacted', {
        messageId: message._id,
        chatId: message.chatId,
        reactions: message.reactions,
      });
    } catch (error) {
      console.error('Error removing reaction via socket:', error);
      socket.emit('error', { message: 'Failed to remove reaction' });
    }
  });

  // Handle read/delivered receipts
  socket.on('message:status', async (data) => {
    const { messageId, status } = data; // 'delivered' or 'seen'
    const userId = socket.user._id;

    try {
      const message = await Message.findById(messageId);
      if (!message) return;

      // Only update if current status is 'sent' or (if updating to 'seen') is 'delivered'
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
        io.to(message.chatId.toString()).emit('message:status:updated', {
          messageId: message._id,
          chatId: message.chatId,
          status: message.status,
        });
      }
    } catch (error) {
      console.error('Error updating status:', error);
    }
  });

  // Handle typing indicators
  socket.on('typing:start', (data) => {
    const { chatId } = data;
    socket.to(chatId.toString()).emit('typing:started', {
      chatId,
      userId: socket.user._id,
    });
  });

  socket.on('typing:stop', (data) => {
    const { chatId } = data;
    socket.to(chatId.toString()).emit('typing:stopped', {
      chatId,
      userId: socket.user._id,
    });
  });
};
