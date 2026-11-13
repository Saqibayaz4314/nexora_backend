-- 0007 down: invites + group metadata revert.

DROP TABLE IF EXISTS conversation_invites;
ALTER TABLE conversations DROP CONSTRAINT IF EXISTS conversations_icon_media_fk;
ALTER TABLE conversations DROP COLUMN IF EXISTS icon_media_id;
ALTER TABLE conversations DROP COLUMN IF EXISTS description;
ALTER TABLE conversations DROP COLUMN IF EXISTS name;
