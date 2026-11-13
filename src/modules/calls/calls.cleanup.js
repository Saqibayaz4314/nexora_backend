'use strict';

// Call cleanup — stale ringing calls missed ho jate hain, stale ongoing calls ended.
// Scheduled job hai (media cleanup ki tarah): scripts/cleanup-calls.js.

const BATCH_LIMIT = 500;

async function runCallCleanup({ db, repo, logger, now = new Date(), config }) {
  if (!db) {
    logger && logger.warn('DATABASE_URL set nahi hai — call cleanup skip');
    return { removedRinging: 0, removedOngoing: 0 };
  }

  const ringTimeoutSeconds = (config && config.callRingTimeoutSeconds) || 60;
  const maxDurationSeconds = (config && config.callMaxDurationSeconds) || 24 * 60 * 60;

  const ringingCutoff = new Date(now.getTime() - ringTimeoutSeconds * 1000);
  const ongoingCutoff = new Date(now.getTime() - maxDurationSeconds * 1000);

  const staleRinging = await repo.listStaleRinging(ringingCutoff, BATCH_LIMIT);
  const staleOngoing = await repo.listStaleOngoing(ongoingCutoff, BATCH_LIMIT);

  const removedRinging = await repo.markStale(staleRinging, 'missed');
  const removedOngoing = await repo.markStale(staleOngoing, 'ended');

  return { removedRinging, removedOngoing };
}

module.exports = { runCallCleanup, BATCH_LIMIT };
