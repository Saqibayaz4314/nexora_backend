-- 0004 down: FK pehle hatana zaroori hai (messages par), phir table drop.

ALTER TABLE messages DROP CONSTRAINT IF EXISTS messages_media_fk;
DROP TABLE IF EXISTS media_objects;
