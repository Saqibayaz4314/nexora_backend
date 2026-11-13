-- 0006: Status (WhatsApp-style 24h posts) — Stage 6.
-- Status media Stage 4 ke media_objects flow ko reuse karta hai (upload → complete → yahan link).
-- Visibility: author ke contacts (+ author khud); blocked users hamesha excluded.
-- Expiry: expires_at (default 24h) — cleanup job expired posts ko soft-delete karta hai.

CREATE TABLE IF NOT EXISTS status_posts (
  id uuid PRIMARY KEY,
  author_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  media_id uuid REFERENCES media_objects(id) ON DELETE SET NULL,
  caption_ciphertext text NOT NULL DEFAULT '',
  caption_nonce varchar(64) NOT NULL DEFAULT '',
  caption_auth_tag varchar(64) NOT NULL DEFAULT '',
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE INDEX IF NOT EXISTS status_posts_author_created_idx ON status_posts (author_user_id, created_at DESC, id DESC);
-- Note: expires_at par standalone index nahi — cleanup batched hai (LIMIT 500), scan acceptable.

CREATE TABLE IF NOT EXISTS status_views (
  post_id uuid NOT NULL REFERENCES status_posts(id) ON DELETE CASCADE,
  viewer_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  viewed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (post_id, viewer_user_id)
);

CREATE TABLE IF NOT EXISTS status_reactions (
  post_id uuid NOT NULL REFERENCES status_posts(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reaction_ciphertext varchar(1000) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (post_id, user_id)
);

-- Status replies: chat reply status_post_id ke saath aata hai (conversation message ban jata hai).
ALTER TABLE messages ADD COLUMN IF NOT EXISTS status_post_id uuid;
ALTER TABLE messages
  ADD CONSTRAINT messages_status_post_fk FOREIGN KEY (status_post_id) REFERENCES status_posts(id) ON DELETE SET NULL;
