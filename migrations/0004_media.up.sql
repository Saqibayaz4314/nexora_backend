-- 0004: Media objects — private storage ke metadata (S3 object keys server-generated hain).
-- Upload flow: initiate (pending) → client PUT presigned URL → complete (ready).
-- Stage 4 tak media_id ab messages se link hota hai (download authz ke liye).

CREATE TABLE IF NOT EXISTS media_objects (
  id uuid PRIMARY KEY,
  owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  s3_key varchar(1024) NOT NULL,
  media_type varchar(32) NOT NULL,
  content_type varchar(255) NOT NULL DEFAULT '',
  byte_size bigint NOT NULL DEFAULT 0,
  checksum varchar(128) NOT NULL DEFAULT '',
  encryption_nonce varchar(64) NOT NULL DEFAULT '',
  encryption_auth_tag varchar(64) NOT NULL DEFAULT '',
  status varchar(16) NOT NULL DEFAULT 'pending',
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  deleted_at timestamptz,
  CONSTRAINT media_objects_type_check CHECK (media_type IN ('image', 'video', 'audio', 'document')),
  CONSTRAINT media_objects_status_check CHECK (status IN ('pending', 'ready'))
);
CREATE INDEX IF NOT EXISTS media_objects_owner_idx ON media_objects (owner_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS media_objects_status_created_idx ON media_objects (status, created_at);
-- Note: deleted_at par standalone index nahi — cleanup job scheduled batch hai (LIMIT 500), scan acceptable.

-- messages.media_id ab FK ban jata hai (0003 mein FK nahi tha).
ALTER TABLE messages
  ADD CONSTRAINT messages_media_fk FOREIGN KEY (media_id) REFERENCES media_objects(id) ON DELETE SET NULL;
