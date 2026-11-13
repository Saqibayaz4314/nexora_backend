'use strict';

const logger = require('./logger');

// Stable machine-readable error codes ke saath centralized error handling.
class AppError extends Error {
  constructor(statusCode, code, message, details) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

// async route handlers ke liye wrapper — thrown errors errorHandler tak pohanchte hain.
function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

function mapError(err) {
  if (err instanceof AppError) {
    return { statusCode: err.statusCode, code: err.code, message: err.message, details: err.details };
  }

  // JWT verification errors
  if (err && (err.name === 'JsonWebTokenError' || err.name === 'TokenExpiredError' || err.name === 'NotBeforeError')) {
    return { statusCode: 401, code: 'TOKEN_INVALID_OR_EXPIRED', message: 'Invalid or expired token' };
  }

  // Postgres unique violation
  if (err && err.code === '23505') {
    return { statusCode: 409, code: 'CONFLICT', message: 'Resource already exists' };
  }

  // Postgres constraint violation
  if (err && err.code === '23503') {
    return { statusCode: 409, code: 'CONFLICT', message: 'Referenced resource does not exist' };
  }

  // Body parse errors
  if (err && err.type === 'entity.parse.failed') {
    return { statusCode: 400, code: 'INVALID_JSON', message: 'Invalid JSON body' };
  }

  if (err && err.type === 'entity.too.large') {
    return { statusCode: 413, code: 'PAYLOAD_TOO_LARGE', message: 'Request body too large' };
  }

  return { statusCode: 500, code: 'INTERNAL_ERROR', message: 'Something went wrong. Please try again.' };
}

function errorHandler(err, req, res, _next) {
  if (res.headersSent) {
    return;
  }

  const mapped = mapError(err);
  const requestId = req.id || 'unknown';

  if (mapped.statusCode >= 500) {
    logger.error({ err: { message: err.message, stack: err.stack }, requestId }, 'Unhandled error');
  } else {
    logger.warn({ code: mapped.code, message: mapped.message, requestId }, 'Request error');
  }

  // Stack traces kabhi client ko nahi bheje jaate.
  res.status(mapped.statusCode).json({
    data: null,
    error: { code: mapped.code, message: mapped.message, details: mapped.details || undefined },
    requestId,
  });
}

function notFoundHandler(req, res) {
  res.status(404).json({
    data: null,
    error: { code: 'ROUTE_NOT_FOUND', message: 'Route not found' },
    requestId: req.id || 'unknown',
  });
}

module.exports = { AppError, asyncHandler, errorHandler, notFoundHandler };
