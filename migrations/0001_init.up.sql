-- 0001: Auth foundation tables (users, devices, user_sessions, email_tokens)
-- UUIDs app-side generate hote hain. Timestamps UTC (timestamptz).

CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY,
  username varchar(32) NOT NULL,
  username_norm varchar(32) NOT NULL,
  email varchar(255) NOT NULL,
  email_norm varchar(255) NOT NULL,
  password_hash varchar(255) NOT NULL,
  display_name varchar(100) NOT NULL DEFAULT '',
  avatar_key varchar(512) NOT NULL DEFAULT '',
  about text NOT NULL DEFAULT '',
  email_verified_at timestamptz,
  discoverable boolean NOT NULL DEFAULT true,
  last_seen_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CONSTRAINT users_username_norm_unique UNIQUE (username_norm),
  CONSTRAINT users_email_norm_unique UNIQUE (email_norm)
);

CREATE TABLE IF NOT EXISTS devices (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  platform varchar(32) NOT NULL DEFAULT 'unknown',
  device_name varchar(128) NOT NULL DEFAULT '',
  identity_public_key text,
  push_token text,
  last_seen_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS devices_user_id_idx ON devices (user_id);

CREATE TABLE IF NOT EXISTS user_sessions (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id uuid REFERENCES devices(id) ON DELETE SET NULL,
  token_hash varchar(64) NOT NULL,
  family_id uuid NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  last_used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT user_sessions_token_hash_unique UNIQUE (token_hash)
);
CREATE INDEX IF NOT EXISTS user_sessions_user_id_idx ON user_sessions (user_id);
CREATE INDEX IF NOT EXISTS user_sessions_family_id_idx ON user_sessions (family_id);

CREATE TABLE IF NOT EXISTS email_tokens (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind varchar(32) NOT NULL,
  token_hash varchar(64) NOT NULL,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT email_tokens_kind_check CHECK (kind IN ('email_verify', 'password_reset'))
);
CREATE INDEX IF NOT EXISTS email_tokens_user_kind_idx ON email_tokens (user_id, kind);
CREATE INDEX IF NOT EXISTS email_tokens_hash_idx ON email_tokens (token_hash);
