-- 0007: Groups — conversation metadata + invites.
-- kind='group' conversations ke liye name/description/icon; invites table.
-- messages FK ON DELETE CASCADE hai, isliye group delete → messages bhi saath.

ALTER TABLE conversations ADD COLUMN IF NOT EXISTS name varchar(200) NOT NULL DEFAULT '';
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS description text NOT NULL DEFAULT '';
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS icon_media_id uuid;
ALTER TABLE conversations ADD CONSTRAINT conversations_icon_media_fk
  FOREIGN KEY (icon_media_id) REFERENCES media_objects(id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS conversation_invites (
  id uuid PRIMARY KEY,
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  inviter_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  invitee_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status varchar(16) NOT NULL DEFAULT 'pending',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- Ek user ko ek conversation mein ek hi invite row (re-invite = update same row).
  CONSTRAINT conversation_invites_pair_unique UNIQUE (conversation_id, invitee_user_id),
  CONSTRAINT conversation_invites_status_check CHECK (status IN ('pending', 'accepted', 'declined', 'cancelled'))
);
CREATE INDEX IF NOT EXISTS conversation_invites_invitee_idx ON conversation_invites (invitee_user_id, status);
