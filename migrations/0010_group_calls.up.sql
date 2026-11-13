-- 0010: Group calls — mesh WebRTC participants.
-- call_sessions wahi "call room" row hai (1:1 aur group dono); group calls
-- mein offer/answer per-peer relay hote hain (store nahi), isliye sirf
-- participation tracking chahiye. UNIQUE(call_id, user_id) idempotent join
-- deta hai; left_at NULL = active participant.

CREATE TABLE IF NOT EXISTS call_participants (
  id uuid PRIMARY KEY,
  call_id uuid NOT NULL REFERENCES call_sessions(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  joined_at timestamptz NOT NULL DEFAULT now(),
  left_at timestamptz,
  CONSTRAINT call_participants_call_user_uniq UNIQUE (call_id, user_id)
);
CREATE INDEX IF NOT EXISTS call_participants_call_active_idx
  ON call_participants (call_id) WHERE left_at IS NULL;
CREATE INDEX IF NOT EXISTS call_participants_user_active_idx
  ON call_participants (user_id) WHERE left_at IS NULL;
