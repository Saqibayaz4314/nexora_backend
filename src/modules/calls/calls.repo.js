'use strict';

// Calls repo — call_sessions table access (Stage 5).
// Signaling call IDs par hoti hai; status transitions yahan atomic hain
// (WHERE status = expected → koi race nahi).

function encodeCursor(createdAt, id) {
  const iso = createdAt instanceof Date ? createdAt.toISOString() : String(createdAt);
  return Buffer.from(`${iso}|${id}`, 'utf8').toString('base64url');
}

function decodeCursor(cursor) {
  if (!cursor || typeof cursor !== 'string') return null;
  try {
    const raw = Buffer.from(cursor, 'base64url').toString('utf8');
    const sep = raw.lastIndexOf('|');
    if (sep < 0) return null;
    const iso = raw.slice(0, sep);
    const id = raw.slice(sep + 1);
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return null;
    return { createdAt: date, id };
  } catch {
    return null;
  }
}

const CALL_COLUMNS = `
  cs.id, cs.conversation_id, cs.initiator_user_id, cs.call_type, cs.status,
  cs.offer_sdp, cs.answer_sdp, cs.started_at, cs.ended_at, cs.created_at`;

// INSERT/UPDATE RETURNING mein table alias use nahi hota (PG bhi allow nahi karta).
const CALL_RETURN_COLUMNS = `
  id, conversation_id, initiator_user_id, call_type, status,
  offer_sdp, answer_sdp, started_at, ended_at, created_at`;

function toCall(row) {
  if (!row) return null;
  return {
    id: row.id,
    conversationId: row.conversation_id,
    initiatorUserId: row.initiator_user_id,
    callType: row.call_type,
    status: row.status,
    offerSdp: row.offer_sdp,
    answerSdp: row.answer_sdp,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    createdAt: row.created_at,
  };
}

// status IN clause dynamic placeholders se (pg-mem ANY() cast issue se bachta hai).
function inPlaceholders(list, startIndex = 1) {
  return list.map((_, i) => `$${startIndex + i}`).join(', ');
}

function createCallsRepo({ db }) {
  const q = (text, params) => {
    if (!db) {
      const err = new Error('Database configured nahi hai');
      err.code = 'DB_NOT_CONFIGURED';
      throw err;
    }
    return db.query(text, params);
  };

  return {
    encodeCursor,
    decodeCursor,
    toCall,

    async findMembership(conversationId, userId) {
      const res = await q(
        `SELECT cm.user_id, cm.role, cm.left_at, c.kind
         FROM conversation_members cm
         JOIN conversations c ON c.id = cm.conversation_id
         WHERE cm.conversation_id = $1 AND cm.user_id = $2
         LIMIT 1`,
        [conversationId, userId]
      );
      return res.rows[0] || null;
    },

    async getOtherMemberId(conversationId, excludeUserId) {
      const res = await q(
        `SELECT user_id FROM conversation_members
         WHERE conversation_id = $1 AND user_id <> $2 AND left_at IS NULL
         LIMIT 1`,
        [conversationId, excludeUserId]
      );
      return res.rows[0] ? res.rows[0].user_id : null;
    },

    async insertCall({ id, conversationId, initiatorUserId, callType, status, offerSdp }) {
      const res = await q(
        `INSERT INTO call_sessions
           (id, conversation_id, initiator_user_id, call_type, status, offer_sdp)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING ${CALL_RETURN_COLUMNS}`,
        [id, conversationId, initiatorUserId, callType, status, offerSdp || null]
      );
      return res.rows[0] || null;
    },

    async findCallById(callId) {
      const res = await q(
        `SELECT ${CALL_COLUMNS} FROM call_sessions cs WHERE cs.id = $1 LIMIT 1`,
        [callId]
      );
      return res.rows[0] || null;
    },

    // Atomic transition: sirf expected statuses se move hota hai.
    // SET clause dynamic hai (pg-mem COALESCE(null, col) type-inference issue se bachta hai).
    async transitionStatus(callId, fromStatuses, toStatus, { answerSdp, startedAt, endedAt } = {}) {
      const sets = ['status = $1'];
      const params = [toStatus];
      if (answerSdp !== undefined && answerSdp !== null) {
        params.push(answerSdp);
        sets.push(`answer_sdp = $${params.length}`);
      }
      if (startedAt !== undefined && startedAt !== null) {
        params.push(startedAt);
        sets.push(`started_at = $${params.length}`);
      }
      if (endedAt !== undefined && endedAt !== null) {
        params.push(endedAt);
        sets.push(`ended_at = $${params.length}`);
      }
      params.push(callId);
      const fromClause = fromStatuses.length > 0
        ? `AND status IN (${inPlaceholders(fromStatuses, params.length + 1)})`
        : '';
      const res = await q(
        `UPDATE call_sessions
         SET ${sets.join(', ')}
         WHERE id = $${params.length} ${fromClause}
         RETURNING ${CALL_RETURN_COLUMNS}`,
        [...params, ...fromStatuses]
      );
      return res.rows[0] || null;
    },

    // Expire before busy lookup, using the same status guard as answer/reject.
    // If an answer wins the race, its ongoing row must still count as busy.
    async expireRingingCallsForUser(userId, cutoff) {
      await q(
        `UPDATE call_sessions SET status = 'missed', ended_at = now()
         WHERE status = 'ringing' AND created_at <= $2
           AND conversation_id IN (
             SELECT conversation_id FROM conversation_members
             WHERE user_id = $1 AND left_at IS NULL
           )`,
        [userId, cutoff]
      );
    },

    // Busy detection: user kisi active (ringing/ongoing) call ka member hai ya nahi.
    async findActiveCallForUser(userId, since) {
      const res = await q(
        `SELECT cs.id FROM call_sessions cs
         JOIN conversation_members cm
           ON cm.conversation_id = cs.conversation_id AND cm.left_at IS NULL
         WHERE cm.user_id = $1
           AND cs.status IN ('ringing', 'ongoing')
           AND cs.created_at > $2
         LIMIT 1`,
        [userId, since]
      );
      return res.rows[0] ? res.rows[0].id : null;
    },

    async listCalls(conversationId, cursor, limit) {
      let where = 'WHERE cs.conversation_id = $1';
      const params = [conversationId];
      if (cursor) {
        where += ' AND (cs.created_at < $2 OR (cs.created_at = $2 AND cs.id < $3))';
        params.push(cursor.createdAt, cursor.id);
      }
      params.push(limit + 1);
      const res = await q(
        `SELECT ${CALL_COLUMNS} FROM call_sessions cs
         ${where}
         ORDER BY cs.created_at DESC, cs.id DESC
         LIMIT $${params.length}`,
        params
      );
      return res.rows;
    },

    // Cleanup: stale ringing/ongoing rows batch mein.
    async listStaleRinging(cutoff, limit) {
      const res = await q(
        `SELECT id FROM call_sessions
         WHERE status = 'ringing' AND created_at < $1
         ORDER BY created_at
         LIMIT $2`,
        [cutoff, limit]
      );
      return res.rows.map((r) => r.id);
    },

    // Stale ringing + caller ka naam — missed-call push ke liye.
    async listStaleRingingDetails(cutoff, limit) {
      const res = await q(
        `SELECT cs.id, cs.conversation_id, cs.initiator_user_id, cs.call_type,
                u.display_name AS initiator_display_name,
                u.username AS initiator_username
         FROM call_sessions cs
         JOIN users u ON u.id = cs.initiator_user_id
         WHERE cs.status = 'ringing' AND cs.created_at < $1
         ORDER BY cs.created_at
         LIMIT $2`,
        [cutoff, limit]
      );
      return res.rows;
    },

    async listStaleOngoing(cutoff, limit) {
      const res = await q(
        `SELECT id FROM call_sessions
         WHERE status = 'ongoing' AND started_at IS NOT NULL AND started_at < $1
         ORDER BY started_at
         LIMIT $2`,
        [cutoff, limit]
      );
      return res.rows.map((r) => r.id);
    },

    async markStale(ids, toStatus) {
      if (ids.length === 0) return 0;
      const res = await q(
        `UPDATE call_sessions SET status = $1, ended_at = now()
         WHERE id IN (${inPlaceholders(ids, 2)}) AND ended_at IS NULL`,
        [toStatus, ...ids]
      );
      return res.rowCount;
    },
  };
}

module.exports = { createCallsRepo };
