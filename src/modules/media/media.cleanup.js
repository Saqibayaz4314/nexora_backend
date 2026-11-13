'use strict';

// Media cleanup — retention rules:
// - 'pending' media jo 24h se zyada purana hai (upload kabhi complete nahi hua) → object + row delete.
// - Soft-deleted media jo 7 din se zyada purana hai → object + row permanently delete.
// Heroku scheduler ya cron se `npm run cleanup:media` chalao.

const PENDING_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const DELETED_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

async function runMediaCleanup({ db, repo, storage, logger, now = new Date() }) {
  if (!db) {
    throw new Error('Media cleanup ko database chahiye');
  }
  const pendingThreshold = new Date(now.getTime() - PENDING_TTL_MS);
  const deletedThreshold = new Date(now.getTime() - DELETED_TTL_MS);

  let removedPending = 0;
  let removedDeleted = 0;

  const pendingRows = await repo.listPendingOlderThan(pendingThreshold);
  for (const row of pendingRows) {
    // eslint-disable-next-line no-await-in-loop
    await storage.deleteObject(row.s3_key);
    // eslint-disable-next-line no-await-in-loop
    await repo.deleteRow(row.id);
    removedPending += 1;
  }

  const deletedRows = await repo.listDeletedOlderThan(deletedThreshold);
  for (const row of deletedRows) {
    // eslint-disable-next-line no-await-in-loop
    await storage.deleteObject(row.s3_key);
    // eslint-disable-next-line no-await-in-loop
    await repo.deleteRow(row.id);
    removedDeleted += 1;
  }

  if (logger && logger.info) {
    logger.info({ removedPending, removedDeleted }, 'Media cleanup complete');
  }
  return { removedPending, removedDeleted };
}

module.exports = { runMediaCleanup, PENDING_TTL_MS, DELETED_TTL_MS };
