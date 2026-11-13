'use strict';

// Consistent response envelope: { data, error, requestId }
function ok(res, data, statusCode = 200) {
  res.status(statusCode).json({
    data,
    error: null,
    requestId: res.req.id || 'unknown',
  });
}

module.exports = { ok };
