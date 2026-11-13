'use strict';

// Media cleanup job — `npm run cleanup:media` (Heroku Scheduler ke liye ready).

const config = require('../src/config');
const logger = require('../src/shared/logger');
const { getPool, closePg } = require('../src/shared/db/pg');
const { createMediaRepo } = require('../src/modules/media/media.repo');
const { createObjectStorage } = require('../src/shared/storage/object-storage');
const { runMediaCleanup } = require('../src/modules/media/media.cleanup');

async function main() {
  const pool = getPool();
  if (!pool) {
    logger.warn('DATABASE_URL set nahi hai — media cleanup skip');
    return;
  }
  const repo = createMediaRepo({ db: pool });
  const storage = createObjectStorage({ config, logger });
  const result = await runMediaCleanup({ db: pool, repo, storage, logger });
  logger.info({ result }, 'cleanup:media done');
}

main()
  .catch((err) => {
    logger.error({ err: { message: err.message } }, 'cleanup:media failed');
    process.exitCode = 1;
  })
  .finally(async () => {
    await closePg();
  });
