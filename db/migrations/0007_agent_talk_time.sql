-- Seconds an agent actually talked on the call (0 = only IVR / bot, NULL = provider did not say),
-- and why a call was not sent for transcription (only calls where an agent spoke are transcribed).
ALTER TABLE calls ADD COLUMN IF NOT EXISTS agent_talk_seconds int;
ALTER TABLE calls ADD COLUMN IF NOT EXISTS transcription_skipped text;
