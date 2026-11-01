-- What each agent handles (set in Team → Agents): incoming_calls, outgoing_calls, chat_whatsapp, email — and a free-text note.
ALTER TABLE agents ADD COLUMN IF NOT EXISTS handles text[] NOT NULL DEFAULT '{}';
ALTER TABLE agents ADD COLUMN IF NOT EXISTS work_note text;
