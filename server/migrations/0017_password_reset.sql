-- Self-service password reset by e-mail link (core/identity/password-reset.ts).
--
-- Only the SHA-256 of a reset token is stored; a token works once, expires after PASSWORD_RESET_MINUTES (30 by
-- default) and a newer request supersedes it. The link travels through the notifications outbox like every other
-- message. Using it sets the new password, signs out every session of the account and is audited.
-- Additive only: a new table and one PALTAS default template (inserted only if missing).

CREATE TABLE password_resets (
  id               text PRIMARY KEY,
  user_id          text NOT NULL REFERENCES users(id),
  token_hash       text NOT NULL UNIQUE,
  expires_at       timestamptz NOT NULL,
  used_at          timestamptz,
  superseded_at    timestamptz,
  requested_ip     text NOT NULL,
  notification_id  text REFERENCES notifications(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  CHECK (used_at IS NULL OR superseded_at IS NULL)
);
CREATE INDEX password_resets_user ON password_resets (user_id, created_at DESC);
CREATE INDEX password_resets_ip ON password_resets (requested_ip, created_at DESC);

INSERT INTO notification_templates (id, org_id, key, channel, subject, body) VALUES
  ('tpl_default_password_reset_email', NULL, 'password.reset', 'email', 'Reset your PALTAS password',
   E'Hello {{name}},\n\nWe received a request to reset the password of your PALTAS account. To choose a new password, open this link. It works once and stays valid for {{minutes}} minutes (until {{expiresAt}}):\n\n{{link}}\n\nWhen you set the new password, every device signed in to your account is signed out.\n\nIf you did not ask for this, you can ignore this email: your password stays as it is.\n\nNeed help? Write to us at {{helpEmail}}.\n\nThe PALTAS team')
ON CONFLICT DO NOTHING;
