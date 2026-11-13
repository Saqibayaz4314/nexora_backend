module.exports = (io, socket) => {
  // Client initiates WebRTC Call
  socket.on('call:initiate', (data) => {
    const { chatId, receiverId, type } = data; // type: 'audio' | 'video'
    const callerId = socket.user._id;

    // Send call initiation notification to receiver
    socket.to(receiverId.toString()).emit('call:incoming', {
      chatId,
      callerId,
      callerName: socket.user.name,
      type,
    });
    console.log(`Call initiated from ${callerId} to ${receiverId}`);
  });

  // Relay WebRTC Offer
  socket.on('call:offer', (data) => {
    const { sdp, receiverId, chatId } = data;
    const senderId = socket.user._id;

    socket.to(receiverId.toString()).emit('call:offer:receive', {
      sdp,
      senderId,
      chatId,
    });
  });

  // Relay WebRTC Answer
  socket.on('call:answer', (data) => {
    const { sdp, callerId, chatId } = data;
    const receiverId = socket.user._id;

    socket.to(callerId.toString()).emit('call:answer:receive', {
      sdp,
      receiverId,
      chatId,
    });
  });

  // Relay ICE Candidates
  socket.on('call:ice-candidate', (data) => {
    const { candidate, peerId, chatId } = data;
    const senderId = socket.user._id;

    socket.to(peerId.toString()).emit('call:ice-candidate:receive', {
      candidate,
      senderId,
      chatId,
    });
  });

  // End Call
  socket.on('call:end', (data) => {
    const { peerId, chatId } = data;
    const senderId = socket.user._id;

    socket.to(peerId.toString()).emit('call:ended', {
      senderId,
      chatId,
    });
  });

  // Reject Call
  socket.on('call:reject', (data) => {
    const { callerId, chatId } = data;
    const rejecterId = socket.user._id;

    socket.to(callerId.toString()).emit('call:rejected', {
      rejecterId,
      chatId,
    });
  });
};
