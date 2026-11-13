'use strict';

// In-memory presence tracker (single dyno setup ke liye).
// Har user ke multiple sockets ho sakte hain (multiple devices / reconnect overlap).
// User "online" tab hai jab uska kam az kam ek socket foreground mein ho.
// Multi-dyno par ye per-process hoga — tab Redis-backed tracker chahiye hoga.

function createPresenceTracker() {
  // userId -> Map<socketId, boolean active>
  const users = new Map();

  function isOnline(userId) {
    const sockets = users.get(userId);
    if (!sockets) return false;
    for (const active of sockets.values()) {
      if (active) return true;
    }
    return false;
  }

  // Socket ki state set karo; return: { before, after } online flags.
  function set(userId, socketId, active) {
    const before = isOnline(userId);
    let sockets = users.get(userId);
    if (!sockets) {
      sockets = new Map();
      users.set(userId, sockets);
    }
    sockets.set(socketId, Boolean(active));
    return { before, after: isOnline(userId) };
  }

  function remove(userId, socketId) {
    const before = isOnline(userId);
    const sockets = users.get(userId);
    if (sockets) {
      sockets.delete(socketId);
      if (sockets.size === 0) users.delete(userId);
    }
    return { before, after: isOnline(userId) };
  }

  return { isOnline, set, remove };
}

module.exports = { createPresenceTracker };
