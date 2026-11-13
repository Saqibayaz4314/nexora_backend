'use strict';

// Standalone status cleanup job — schedule: heroku scheduler / cron har 5 minute.
// Usage: npm run cleanup:status

const config = require('../src/config');
const logger = require('../src/shared/logger');
const { getPool, closePg } = require('../src/shared/db/pg');
const { createStatusRepo } = require('../src/modules/status/status.repo');
const { createMediaRepo } = require('../src/modules/media/media.repo');
const { runStatusCleanup } = require('../src/modules/status/status.cleanup');

async function main() {
  const db = getPool();
  const repo = createStatusRepo({ db });
  const mediaRepo = createMediaRepo({ db });
  const result = await runStatusCleanup({ db, repo, mediaRepo, logger, config });
  logger.info(result, 'status cleanup done');
}

main()
  .catch((err) => {
    logger.error({ err: { message: err.message } }, 'status cleanup failed');
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
