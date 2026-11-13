-- Per-user delete-chat state is independent of active membership.
ALTER TABLE conversation_members ADD COLUMN hidden_at timestamptz;
ALTER TABLE conversation_members ADD COLUMN history_cleared_at timestamptz;
