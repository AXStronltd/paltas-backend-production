-- PALTAS Support chat (additive): a client's conversations with PALTAS. The PALTAS assistant (AI) answers at any hour
-- from PALTAS help and the client's own account facts; the PALTAS team sees every conversation, replies as themselves,
-- assigns and closes them. Messages are never edited or deleted.
CREATE TABLE support_conversations (
  id               text PRIMARY KEY,
  user_id          text NOT NULL REFERENCES users(id),          -- the client who started it
  org_id           text REFERENCES organisations(id),           -- the company it is about (one the client belongs to)
  subject          text NOT NULL CHECK (length(subject) BETWEEN 1 AND 160),
  status           text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  -- a person from PALTAS should answer: the assistant asked for it, the client asked, or the assistant could not reply
  needs_human      boolean NOT NULL DEFAULT false,
  assigned_to      text REFERENCES users(id),
  last_message_at  timestamptz NOT NULL DEFAULT now(),
  last_author      text NOT NULL DEFAULT 'client' CHECK (last_author IN ('client', 'assistant', 'staff', 'system')),
  client_read_at   timestamptz,
  staff_read_at    timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX support_conversations_user ON support_conversations (user_id, last_message_at DESC);
CREATE INDEX support_conversations_inbox ON support_conversations (status, needs_human, last_message_at DESC);

CREATE TABLE support_messages (
  id               bigserial PRIMARY KEY,
  conversation_id  text NOT NULL REFERENCES support_conversations(id),
  author           text NOT NULL CHECK (author IN ('client', 'assistant', 'staff', 'system')),
  author_user_id   text REFERENCES users(id),
  body             text NOT NULL CHECK (length(body) BETWEEN 1 AND 4000),
  -- a note for the PALTAS team only (never shown to the client)
  internal         boolean NOT NULL DEFAULT false,
  ai_model         text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CHECK (internal = false OR author = 'staff'),
  CHECK ((author IN ('client', 'staff')) = (author_user_id IS NOT NULL))
);
CREATE INDEX support_messages_conversation ON support_messages (conversation_id, id);

INSERT INTO notification_templates (id, org_id, key, channel, subject, body) VALUES
  ('tpl_default_support_reply_email', NULL, 'support.reply', 'email', 'PALTAS Support replied: {{subject}}',
   E'Hello {{name}},\n\n{{staffName}} from PALTAS Support replied to your conversation "{{subject}}":\n\n{{excerpt}}\n\nOpen PALTAS and choose Help to read the whole reply and answer: {{link}}');
