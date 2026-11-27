-- The PC's owner token may post directly, alongside enrolled device sessions.
ALTER TABLE messages ADD COLUMN owner_id uuid REFERENCES owners(id) ON DELETE RESTRICT;
ALTER TABLE messages DROP CONSTRAINT messages_owner_session;
ALTER TABLE messages ADD CONSTRAINT messages_owner_principal
 CHECK (author <> 'owner' OR device_session_id IS NOT NULL OR owner_id IS NOT NULL);
-- Second-press window (D23), seeded because a missing value refuses every second press. The owner confirms from a phone:
-- reads the prompt in Telegram or the client, then presses. 300 s matches the device code TTL (device.codeTtlSeconds).
INSERT INTO settings (key, value) VALUES ('confirm.windowSeconds', '300'::jsonb) ON CONFLICT (key) DO NOTHING;
