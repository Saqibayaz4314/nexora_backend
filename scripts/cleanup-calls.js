'use strict';

// Standalone call cleanup job — schedule: heroku scheduler / cron har minute ya 5 minute.
// Usage: npm run cleanup:calls

const config = require('../src/config');
const logger = require('../src/shared/logger');
const { getPool, closePg } = require('../src/shared/db/pg');
const { createCallsRepo } = require('../src/modules/calls/calls.repo');
const { runCallCleanup } = require('../src/modules/calls/calls.cleanup');

async function main() {
  const db = getPool();
  const repo = createCallsRepo({ db });
  const result = await runCallCleanup({ db, repo, logger, config });
  logger.info(result, 'call cleanup done');
}

main()
  .catch((err) => {
    logger.error({ err: { message: err.message } }, 'call cleanup failed');
    process.exitCode = 1;
  })
  .finally(async () => {
    try {
      await closePg();
    } finally {
      // logger flush ho jaye
      setTimeout(() => process.exit(process.exitCode || 0), 50);
    }
  });
