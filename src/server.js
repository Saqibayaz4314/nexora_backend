'use strict';

const http = require('http');
const { Server } = require('socket.io');

const config = require('./config');
const logger = require('./shared/logger');
const { createApp } = require('./app');
const { getPool, pingPg, closePg } = require('./shared/db/pg');
const { closeRedis } = require('./shared/redis');
const connectDB = require('./config/db'); // legacy MongoDB (non-fatal)
const initSockets = require('./sockets');

async function main() {
  // PostgreSQL: production mein fail-fast; dev mein warning.
  const pool = getPool();
  if (pool) {
    const pgStatus = await pingPg();
    if (pgStatus.status === 'up') {
      logger.info('PostgreSQL connected');
    } else if (config.isProd) {
      logger.error({ err: pgStatus.error }, 'PostgreSQL connection failed — startup aborted');
      process.exit(1);
    } else {
      logger.warn({ err: pgStatus.error }, 'PostgreSQL available nahi hai (dev) — /api/v1 auth endpoints disabled');
    }
  } else if (config.isProd) {
    logger.error('DATABASE_URL missing (production)');
    process.exit(1);
  } else {
    logger.warn('DATABASE_URL set nahi hai (dev) — /api/v1 auth endpoints disabled');
  }

  // Legacy MongoDB connection (non-fatal — legacy routes unavailable rehte hain agar down ho)
  connectDB();

  const app = createApp();
  const server = http.createServer(app);

  const io = new Server(server, {
    cors: {
      origin: config.corsOrigins.length > 0 ? config.corsOrigins : '*',
      methods: ['GET', 'POST'],
    },
  });
  app.set('socketio', io);
  initSockets(io);

  // v1 realtime namespace (PG-backed reliable messaging)
  const { initV1Sockets } = require('./sockets/v1Socket');
  app.set('io', io.of('/v1')); // messagesService yahan emit karta hai
  initV1Sockets(io, app);

  server.listen(config.port, () => {
    logger.info(`Server listening on port ${config.port} (${config.nodeEnv})`);
  });

  // Graceful shutdown
  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'Shutdown initiated');
    const forceExit = setTimeout(() => process.exit(1), 10000);
    forceExit.unref();
    try {
      await new Promise((resolve) => server.close(resolve));
      await closePg();
      await closeRedis();
      logger.info('Shutdown complete');
      process.exit(0);
    } catch (err) {
      logger.error({ err: { message: err.message } }, 'Shutdown error');
      process.exit(1);
    }
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  logger.fatal({ err: { message: err.message, stack: err.stack } }, 'Startup failed');
  process.exit(1);
});
