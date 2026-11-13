-- 0002: Contacts, safety (blocks/reports), and one-to-one conversation foundation.
-- friend_requests reserved hai future invite/request flow ke liye (API abhi define nahi).

CREATE TABLE IF NOT EXISTS contacts (
  owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  contact_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  nickname varchar(100) NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_user_id, contact_user_id)
);
CREATE INDEX IF NOT EXISTS contacts_contact_user_idx ON contacts (contact_user_id);

CREATE TABLE IF NOT EXISTS blocked_users (
  blocker_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  blocked_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (blocker_user_id, blocked_user_id)
);
CREATE INDEX IF NOT EXISTS blocked_users_blocked_idx ON blocked_users (blocked_user_id);

CREATE TABLE IF NOT EXISTS friend_requests (
  id uuid PRIMARY KEY,
  requester_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  recipient_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status varchar(16) NOT NULL DEFAULT 'pending',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT friend_requests_status_check CHECK (status IN ('pending', 'accepted', 'declined'))
);
CREATE INDEX IF NOT EXISTS friend_requests_recipient_idx ON friend_requests (recipient_id, status);

CREATE TABLE IF NOT EXISTS reports (
  id uuid PRIMARY KEY,
  reporter_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reported_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reason varchar(32) NOT NULL,
  details text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS reports_reported_user_idx ON reports (reported_user_id);

-- Conversations: one-to-one foundation (groups later stage mein use karenge)
CREATE TABLE IF NOT EXISTS conversations (
  id uuid PRIMARY KEY,
  kind varchar(16) NOT NULL,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT conversations_kind_check CHECK (kind IN ('one_to_one', 'group'))
);

CREATE TABLE IF NOT EXISTS conversation_members (
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role varchar(16) NOT NULL DEFAULT 'member',
  joined_at timestamptz NOT NULL DEFAULT now(),
  left_at timestamptz,
  muted_until timestamptz,
  PRIMARY KEY (conversation_id, user_id),
  CONSTRAINT conversation_members_role_check CHECK (role IN ('owner', 'admin', 'member'))
);
CREATE INDEX IF NOT EXISTS conversation_members_user_idx ON conversation_members (user_id, conversation_id);
