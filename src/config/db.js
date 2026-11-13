'use strict';

const mongoose = require('mongoose');
const config = require('../config');
const logger = require('../shared/logger');

// Legacy MongoDB connection — non-fatal: Atlas down ho to legacy routes
// unavailable rehte hain lekin health/readiness aur v1 API chalti rehti hai.
const connectDB = async () => {
  try {
    const conn = await mongoose.connect(process.env.MONGO_URI || 'mongodb://localhost:27017/nexora');
    logger.info(`Legacy MongoDB connected: ${conn.connection.host}`);
  } catch (error) {
    logger.error({ err: { message: error.message } }, 'Legacy MongoDB connection failed — legacy routes unavailable');
  }
};

module.exports = connectDB;
