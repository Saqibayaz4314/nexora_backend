const jwt = require('jsonwebtoken');
const User = require('../models/User');
const config = require('../config');
const chatSocket = require('./chatSocket');
const presenceSocket = require('./presenceSocket');
const callSocket = require('./callSocket');

module.exports = (io) => {
  // Socket JWT authentication middleware
  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth.token || socket.handshake.query.token;
      if (!token) {
        return next(new Error('Authentication error: Token is required'));
      }

      const decoded = jwt.verify(token, config.jwtAccessSecret);
      const user = await User.findById(decoded.id).select('-password');
      if (!user) {
        return next(new Error('Authentication error: User not found'));
      }

      socket.user = user;
      next();
    } catch (err) {
      console.error('Socket auth failed:', err.message);
      return next(new Error('Authentication error: Invalid token'));
    }
  });

  io.on('connection', (socket) => {
    const userId = socket.user._id.toString();
    
    // Join a personal room named after the User's ID
    socket.join(userId);
    console.log(`Socket client connected: User ${socket.user.name} (${userId})`);

    // Register modular event handlers
    chatSocket(io, socket);
    presenceSocket(io, socket);
    callSocket(io, socket);
  });
};
