'use strict';

const jwt = require('jsonwebtoken');
const config = require('../../config');
const { AppError } = require('../../shared/errors');

// Authorization helpers: authentication sirf pehla step hai —
// har protected route session validity + account state verify karta hai.

function extractBearerToken(req) {
  const header = req.headers.authorization;
  if (header && header.startsWith('Bearer ')) {
    return header.slice(7);
  }
  return null;
}

async function requireAuth(req, _res, next) {
  try {
    const token = extractBearerToken(req);
    if (!token) {
      throw new AppError(401, 'UNAUTHORIZED', 'Authentication required');
    }

    let decoded;
    try {
      decoded = jwt.verify(token, config.jwtAccessSecret, { algorithms: ['HS256'] });
    } catch (err) {
      throw new AppError(401, 'TOKEN_INVALID_OR_EXPIRED', 'Invalid or expired token');
    }
    if (decoded.typ !== 'access') {
      throw new AppError(401, 'TOKEN_INVALID_OR_EXPIRED', 'Invalid token type');
    }

    const repo = req.app.locals.authRepo;
    const session = await repo.findSessionById(decoded.sid);
    if (!session || session.revoked_at) {
      throw new AppError(401, 'SESSION_REVOKED', 'Session revoked. Please log in again.');
    }

    const user = await repo.findUserById(decoded.sub);
    if (!user || user.deleted_at) {
      throw new AppError(401, 'ACCOUNT_UNAVAILABLE', 'Account unavailable');
    }

    req.user = user;
    req.session = session;
    next();
  } catch (err) {
    next(err);
  }
}

// Future stages (chat/calls/status/groups) ke liye: unverified accounts blocked.
function requireVerifiedUser(req, _res, next) {
  if (!req.user || !req.user.email_verified_at) {
    next(new AppError(403, 'EMAIL_NOT_VERIFIED', 'Email verification is required for this action'));
    return;
  }
  next();
}

module.exports = { requireAuth, requireVerifiedUser, extractBearerToken };
