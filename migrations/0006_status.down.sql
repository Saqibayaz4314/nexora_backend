ALTER TABLE messages DROP CONSTRAINT IF EXISTS messages_status_post_fk;
ALTER TABLE messages DROP COLUMN IF EXISTS status_post_id;
DROP TABLE IF EXISTS status_reactions;
DROP TABLE IF EXISTS status_views;
DROP TABLE IF EXISTS status_posts;
