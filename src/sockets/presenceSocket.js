const User = require('../models/User');
const Chat = require('../models/Chat');

module.exports = (io, socket) => {
  // Call this function when the user connects and authenticates
  socket.on('presence:online', async () => {
    const userId = socket.user._id;
    try {
      await User.findByIdAndUpdate(userId, {
        status: 'online',
        lastSeen: new Date(),
      });

      // Find all chats user participates in
      const chats = await Chat.find({ participants: userId });
      
      chats.forEach((chat) => {
        // Notify other participants in the chat room
        socket.to(chat._id.toString()).emit('presence:update', {
          userId,
          status: 'online',
          lastSeen: new Date(),
        });
      });
      console.log(`User ${userId} is online`);
    } catch (error) {
      console.error('Error setting presence online:', error);
    }
  });

  // Handle client disconnect
  socket.on('disconnect', async () => {
    if (!socket.user) return;
    const userId = socket.user._id;

    try {
      const lastSeen = new Date();
      await User.findByIdAndUpdate(userId, {
        status: 'offline',
        lastSeen,
      });

      const chats = await Chat.find({ participants: userId });
      
      chats.forEach((chat) => {
        socket.to(chat._id.toString()).emit('presence:update', {
          userId,
          status: 'offline',
          lastSeen,
        });
      });
      console.log(`User ${userId} disconnected/offline`);
    } catch (error) {
      console.error('Error setting presence offline on disconnect:', error);
    }
  });
};
