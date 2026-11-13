'use strict';

const { AppError } = require('./errors');

// Zod schema validation middleware. Schema shape: { body?, params?, query? }
function validate(schema) {
  return (req, _res, next) => {
    const parsed = schema.safeParse({
      body: req.body,
      params: req.params,
      query: req.query,
    });
    if (!parsed.success) {
      const details = parsed.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      }));
      next(new AppError(400, 'VALIDATION_ERROR', 'Invalid request', details));
      return;
    }
    req.validated = parsed.data;
    next();
  };
}

module.exports = { validate };
