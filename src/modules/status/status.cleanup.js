'use strict';

// Status cleanup — expired posts soft-delete ho jate hain, linked media bhi.
// Scheduled job hai (calls cleanup ki tarah): scripts/cleanup-status.js.

const BATCH_LIMIT = 500;

async function runStatusCleanup({ db, repo, mediaRepo, logger, now = new Date() }) {
  if (!db) {
    logger && logger.warn('DATABASE_URL set nahi hai — status cleanup skip');
    return { removedPosts: 0, removedMedia: 0 };
  }

  let removedPosts = 0;
  let removedMedia = 0;

  // Batched loop — ek batch mein BATCH_LIMIT tak, khatam hone tak chalte hain.
  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    const expired = await repo.listExpiredActive(now, BATCH_LIMIT);
    if (expired.length === 0) break;

    const ids = expired.map((r) => r.id);
    // eslint-disable-next-line no-await-in-loop
    removedPosts += await repo.markExpiredDeleted(ids);

    if (mediaRepo) {
      for (const row of expired) {
        if (!row.media_id) continue;
        try {
          // eslint-disable-next-line no-await-in-loop
          const deleted = await mediaRepo.softDeleteMedia(row.media_id);
          if (deleted) removedMedia += 1;
        } catch (err) {
          // Best-effort: ek media fail ho to baaki posts ki cleanup nahi rukti.
          logger && logger.warn(
            { err: { message: err.message }, mediaId: row.media_id },
            'status media delete failed'
          );
        }
      }
    }

    if (expired.length < BATCH_LIMIT) break;
  }

  return { removedPosts, removedMedia };
}

module.exports = { runStatusCleanup, BATCH_LIMIT };
