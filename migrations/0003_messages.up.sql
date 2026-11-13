-- 0003: Messages, receipts, and reactions (reliable one-to-one chat foundation).
-- media_objects table Stage 4 mein aayega — media_id abhi FK nahi (migration order flexible rahe).

CREATE TABLE IF NOT EXISTS messages (
  id uuid PRIMARY KEY,
  client_message_id varchar(64),
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  sender_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sender_device_id uuid REFERENCES devices(id) ON DELETE SET NULL,
  message_type varchar(32) NOT NULL,
  ciphertext text NOT NULL,
  nonce varchar(64) NOT NULL,
  auth_tag varchar(64) NOT NULL,
  media_id uuid,
  reply_to_id uuid REFERENCES messages(id) ON DELETE SET NULL,
  edited_at timestamptz,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT messages_type_check CHECK (message_type IN ('text', 'image', 'video', 'audio', 'document', 'system'))
);

-- Idempotency: har device apne clientMessageId ko sirf aik baar submit kar sakta hai.
CREATE UNIQUE INDEX IF NOT EXISTS messages_device_client_idx
  ON messages (sender_device_id, client_message_id)
  WHERE client_message_id IS NOT NULL;

-- Cursor pagination keyset index
CREATE INDEX IF NOT EXISTS messages_conv_created_idx
  ON messages (conversation_id, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS messages_reply_to_idx ON messages (reply_to_id);

CREATE TABLE IF NOT EXISTS message_receipts (
  message_id uuid NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  delivered_at timestamptz,
  seen_at timestamptz,
  PRIMARY KEY (message_id, user_id)
);
CREATE INDEX IF NOT EXISTS message_receipts_user_seen_idx ON message_receipts (user_id, seen_at);

CREATE TABLE IF NOT EXISTS message_reactions (
  message_id uuid NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reaction_ciphertext text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (message_id, user_id)
);
