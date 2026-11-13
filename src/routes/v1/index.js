'use strict';

const express = require('express');

const { pingRedis } = require('../../shared/redis');
const { ok } = require('../../shared/respond');
const { asyncHandler } = require('../../shared/errors');
const { makeAuthRoutes } = require('../../modules/auth/auth.routes');
const { makeContactsRouter, makeSafetyRouter } = require('../../modules/contacts/contacts.routes');
const { makeMessagesRouter } = require('../../modules/messages/messages.routes');
const { makeDevicesRouter } = require('../../modules/devices/devices.routes');
const { makeMediaRouter } = require('../../modules/media/media.routes');
const { makeCallsRouter } = require('../../modules/calls/calls.routes');
const { makeStatusRouter } = require('../../modules/status/status.routes');
const { makeGroupsRouter } = require('../../modules/groups/groups.routes');

// /api/v1 router — health/readiness + versioned API surface.
function makeV1Router() {
  const router = express.Router();

  // Liveness: process zinda hai.
  router.get('/health', (_req, res) => {
    ok(res, {
      status: 'ok',
      uptime: Math.floor(process.uptime()),
      version: '1.0.0',
    });
  });

  // Readiness: configured dependencies check karta hai.
  // 'down' dependency → 503; 'not_configured' sirf report hota hai.
  router.get('/readiness', asyncHandler(async (req, res) => {
    const db = req.app.locals.db;
    let postgres;
    if (!db) {
      postgres = 'not_configured';
    } else {
      try {
        await db.query('SELECT 1');
        postgres = 'up';
      } catch (err) {
        postgres = 'down';
      }
    }

    const redisPing = await pingRedis();
    const deps = { postgres, redis: redisPing.status };
    const hasDown = postgres === 'down' || redisPing.status === 'down';
    ok(
      res,
      { status: hasDown ? 'degraded' : 'ok', dependencies: deps },
      hasDown ? 503 : 200
    );
  }));

  router.use('/auth', makeAuthRoutes());
  router.use('/contacts', makeContactsRouter());
  router.use(makeMessagesRouter()); // /conversations/:id/messages + /messages/:id
  router.use('/devices', makeDevicesRouter()); // /devices/push-token
  router.use('/media', makeMediaRouter()); // /media/upload-url, /media/:id/*
  router.use(makeCallsRouter()); // /conversations/:id/calls, /calls/:id, /calls/turn
  router.use(makeStatusRouter()); // /status, /status/:postId/*
  router.use(makeGroupsRouter()); // /conversations/groups, /conversations/:id, /invites
  router.use(makeSafetyRouter()); // /users/:userId/block + /reports

  return router;
}

module.exports = { makeV1Router };
