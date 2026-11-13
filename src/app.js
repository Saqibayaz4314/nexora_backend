'use strict';

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const path = require('path');
const crypto = require('crypto');
const pinoHttp = require('pino-http');
const { rateLimit } = require('express-rate-limit');

const config = require('./config');
const logger = require('./shared/logger');
const { errorHandler, notFoundHandler } = require('./shared/errors');
const { getPool } = require('./shared/db/pg');
const { MailService } = require('./shared/mail/mailer');
const { createAuthRepo } = require('./modules/auth/auth.repo');
const { createAuthService } = require('./modules/auth/auth.service');
const { createContactsRepo } = require('./modules/contacts/contacts.repo');
const { createContactsService } = require('./modules/contacts/contacts.service');
const { createMessagesRepo } = require('./modules/messages/messages.repo');
const { createMessagesService } = require('./modules/messages/messages.service');
const { createDevicesRepo } = require('./modules/devices/devices.repo');
const { createDevicesService } = require('./modules/devices/devices.service');
const { createFcmDispatcher } = require('./shared/push/fcm');
const { createObjectStorage } = require('./shared/storage/object-storage');
const { createMediaRepo } = require('./modules/media/media.repo');
const { createMediaService } = require('./modules/media/media.service');
const { createCallsRepo } = require('./modules/calls/calls.repo');
const { createCallsService } = require('./modules/calls/calls.service');
const { createStatusRepo } = require('./modules/status/status.repo');
const { createStatusService } = require('./modules/status/status.service');
const { createGroupsRepo } = require('./modules/groups/groups.repo');
const { createGroupsService } = require('./modules/groups/groups.service');
const { getRedis } = require('./shared/redis');
const { makeV1Router } = require('./routes/v1');

// Legacy routes (working prototype preserved — Stage 2+ mein migrate honge)
const authRoutes = require('./routes/auth.routes');
const pairingRoutes = require('./routes/pairing.routes');
const chatRoutes = require('./routes/chat.routes');
const mediaRoutes = require('./routes/media.routes');

function genReqId(req) {
  const fromHeader = req.headers['x-request-id'];
  if (typeof fromHeader === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(fromHeader)) {
    return fromHeader;
  }
  return crypto.randomUUID();
}

// App factory: tests apna pool/mailer inject kar sakte hain.
function createApp(options = {}) {
  const app = express();
  app.set('trust proxy', 1); // Heroku router ke peeche — req.ip sahi rahe (rate limiting)

  const pool = options.pool !== undefined ? options.pool : getPool();
  const mailer = options.mailer !== undefined ? options.mailer : MailService.create();
  const authRepo = createAuthRepo({ db: pool });
  const authService = createAuthService({ db: pool, repo: authRepo, mailer });
  const contactsRepo = createContactsRepo({ db: pool });
  const contactsService = createContactsService({ db: pool, repo: contactsRepo });
  const messagesRepo = createMessagesRepo({ db: pool });
  const statusRepo = createStatusRepo({ db: pool });
  const mediaRepo = createMediaRepo({ db: pool });
  const devicesRepo = createDevicesRepo({ db: pool });
  const fcmDispatcher = createFcmDispatcher({ logger });
  // Shared Redis client (null agar REDIS_URL set nahi) — sockets ise
  // app.locals.redis se use karte hain (tests fake inject kar sakte hain).
  app.locals.redis = getRedis();
  const messagesService = createMessagesService({
    db: pool,
    repo: messagesRepo,
    contactsRepo,
    devicesRepo,
    statusRepo,
    mediaRepo,
    pushDispatcher: fcmDispatcher,
    getIo: () => app.get('io'),
    redis: getRedis(),
  });
  const devicesService = createDevicesService({ db: pool, repo: devicesRepo });
  const objectStorage = createObjectStorage({ config, logger });
  const mediaService = createMediaService({
    db: pool,
    repo: mediaRepo,
    storage: objectStorage,
    limits: config.mediaLimits,
    statusRepo,
  });
  const callsRepo = createCallsRepo({ db: pool });
  const callsService = createCallsService({
    db: pool,
    repo: callsRepo,
    contactsRepo,
    devicesRepo,
    pushDispatcher: fcmDispatcher,
    getIo: () => app.get('io'),
    redis: getRedis(),
    config,
  });
  const statusService = createStatusService({
    db: pool,
    repo: statusRepo,
    mediaRepo,
    config,
  });
  const groupsRepo = createGroupsRepo({ db: pool });
  const groupsService = createGroupsService({
    db: pool,
    repo: groupsRepo,
    contactsRepo,
    mediaRepo,
    getIo: () => app.get('io'),
  });
  app.locals.db = pool;
  app.locals.mailer = mailer;
  app.locals.authRepo = authRepo;
  app.locals.authService = authService;
  app.locals.contactsRepo = contactsRepo;
  app.locals.contactsService = contactsService;
  app.locals.messagesRepo = messagesRepo;
  app.locals.messagesService = messagesService;
  app.locals.devicesRepo = devicesRepo;
  app.locals.devicesService = devicesService;
  app.locals.fcmDispatcher = fcmDispatcher;
  app.locals.objectStorage = objectStorage;
  app.locals.mediaRepo = mediaRepo;
  app.locals.mediaService = mediaService;
  app.locals.callsRepo = callsRepo;
  app.locals.callsService = callsService;
  app.locals.statusRepo = statusRepo;
  app.locals.statusService = statusService;
  app.locals.groupsRepo = groupsRepo;
  app.locals.groupsService = groupsService;

  // Security headers
  app.use(helmet());

  // CORS: env se configured origins; dev mein permissive.
  const corsOptions = config.corsOrigins.length > 0 ? { origin: config.corsOrigins } : { origin: true };
  app.use(cors(corsOptions));

  app.use(express.json({ limit: '1mb' }));

  // Structured request logging with request IDs (health/readiness skip hote hain)
  app.use(
    pinoHttp({
      logger,
      genReqId,
      autoLogging: {
        ignore: (req) => req.url === '/api/v1/health' || req.url === '/api/v1/readiness',
      },
      customProps: (req) => ({ requestId: req.id }),
      redact: ['req.headers.authorization', 'req.body.password', 'req.body.token', 'req.body.refreshToken'],
    })
  );

  // Old public disk media is development-only; production uses private v1 media.
  if (!config.isProd) {
    app.use('/uploads', express.static(path.join(__dirname, '..', 'public', 'uploads')));
  }

  // Legacy rate limiting (pairing/legacy auth brute force)
  const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100,
    standardHeaders: true,
    legacyHeaders: false,
    message: { message: 'Too many requests, please try again later.' },
  });

  // Legacy API surface — mobile app ke working behavior ko preserve karte hain.
  app.use('/api/auth', authLimiter, authRoutes);
  app.use('/api/pairing', authLimiter, pairingRoutes);
  app.use('/api/chats', chatRoutes);
  if (!config.isProd) {
    app.use('/api/media', mediaRoutes);
  }

  // New versioned API
  app.use('/api/v1', makeV1Router());

  app.get('/', (_req, res) => {
    res.json({ message: `${config.appName} API is active.`, docs: '/api/v1/health' });
  });

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

module.exports = { createApp };
