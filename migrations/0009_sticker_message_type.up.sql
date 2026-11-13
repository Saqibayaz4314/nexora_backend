-- Sticker messages: emoji-as-sticker 'sticker' type ke liye CHECK constraint extend.
ALTER TABLE messages DROP CONSTRAINT messages_type_check;
ALTER TABLE messages ADD CONSTRAINT messages_type_check
  CHECK (message_type IN ('text', 'image', 'video', 'audio', 'document', 'system', 'sticker'));
