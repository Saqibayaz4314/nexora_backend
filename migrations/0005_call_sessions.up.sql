-- 0005: Call sessions — authenticated WebRTC call lifecycle (Stage 5).
-- Signaling call IDs par hoti hai; SDP offer/answer yahan store hote hain
-- (reconnect/rejoin ke liye), media khud peer-to-peer WebRTC hai.
-- Status flow: ringing → ongoing → ended | missed | rejected | cancelled.

CREATE TABLE IF NOT EXISTS call_sessions (
  id uuid PRIMARY KEY,
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  initiator_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  call_type varchar(10) NOT NULL,
  status varchar(16) NOT NULL DEFAULT 'ringing',
  offer_sdp text,
  answer_sdp text,
  started_at timestamptz,
  ended_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT call_sessions_type_check CHECK (call_type IN ('voice', 'video')),
  CONSTRAINT call_sessions_status_check CHECK (status IN ('ringing', 'ongoing', 'ended', 'missed', 'rejected', 'cancelled'))
);
CREATE INDEX IF NOT EXISTS call_sessions_conv_created_idx ON call_sessions (conversation_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS call_sessions_status_created_idx ON call_sessions (status, created_at);
