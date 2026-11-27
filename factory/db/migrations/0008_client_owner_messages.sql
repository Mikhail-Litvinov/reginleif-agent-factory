-- The PC's owner token may post directly, alongside enrolled device sessions.
ALTER TABLE messages ADD COLUMN owner_id uuid REFERENCES owners(id) ON DELETE RESTRICT;
ALTER TABLE messages DROP CONSTRAINT messages_owner_session;
ALTER TABLE messages ADD CONSTRAINT messages_owner_principal
 CHECK (author <> 'owner' OR device_session_id IS NOT NULL OR owner_id IS NOT NULL);
