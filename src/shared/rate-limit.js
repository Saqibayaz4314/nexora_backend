'use strict';

// Shared rate limiter factory — auth aur contacts modules dono use karte hain.
const { rateLimit } = require('express-rate-limit');

function makeLimiter({ windowMs, max, keyBy }) {
  return rateLimit({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: keyBy,
    handler: (req, res) => {
      res.status(429).json({
        data: null,
        error: { code: 'RATE_LIMITED', message: 'Too many attempts. Please try again later.' },
        requestId: req.id || 'unknown',
      });
    },
  });
}

module.exports = { makeLimiter };
