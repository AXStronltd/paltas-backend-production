-- Real e-mail delivery through a provider (SMTP, or Resend, Postmark or SendGrid over HTTPS; PLATFORM_EMAIL_PROVIDER /
-- PLATFORM_EMAIL_FROM), the delivery outcomes the providers report, a trial-policy switch that keeps unverified sign-ups from
-- being suspended while no e-mail can reach them, and the PALTAS wording of the sign-up and trial messages.
--
-- Safe on a populated database (additive only): the status CHECK is replaced by a superset; the new columns are
-- nullable or NOT NULL with a default; the new CHECK involves only the new statuses (no existing row has them); a
-- PALTAS default template is reworded only where it still holds exactly the wording migration 0013 gave it.

-- ---------------------------------------------------------------- outbox statuses
-- recorded → sent (the provider ACCEPTED the message and returned its id) → delivered / bounced (the provider's signed
-- delivery webhook). queued stays for adapters that hand on without a provider id (the test adapter: nothing sent).
ALTER TABLE notifications DROP CONSTRAINT notifications_status_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_status_check
  CHECK (status IN ('recorded', 'queued', 'sent', 'delivered', 'bounced', 'failed', 'suppressed'));
ALTER TABLE notifications ADD COLUMN delivered_at timestamptz;
ALTER TABLE notifications ADD COLUMN bounced_at timestamptz;
-- like "sent": delivered and bounced only ever come from a real provider (never the test adapter)
ALTER TABLE notifications ADD CONSTRAINT notification_outcome_needs_provider CHECK (
  status NOT IN ('delivered', 'bounced')
  OR (provider IS NOT NULL AND provider <> 'test' AND provider_message_id IS NOT NULL));
-- (provider, provider_message_id) lookups use the unique index notifications_provider_msg of 0012.

-- ---------------------------------------------------------------- trial policy: no suspension without e-mail
-- On (default): an unverified sign-up is suspended only while an e-mail provider is configured, so nobody is
-- suspended for not opening a link that could never reach them.
ALTER TABLE trial_policy ADD COLUMN suspend_unverified_requires_delivery boolean NOT NULL DEFAULT true;

-- ---------------------------------------------------------------- PALTAS default wording (plain and warm)
-- {{helpEmail}} is filled by the outbox from the one PLATFORM_EMAIL_FROM setting, so the help
-- address is never written into a template.
UPDATE notification_templates SET subject = 'Please confirm your email address for PALTAS',
  body = E'Hello {{name}},\n\nWelcome to PALTAS! Your {{productName}} free trial for {{orgName}} is ready, and you can start using it straight away.\n\nPlease confirm that this is your email address by opening this link. It works once and stays valid until {{expiresAt}}:\n\n{{link}}\n\nOnce your email is confirmed you can choose a plan and invite your team.\n\nIf you did not sign up for PALTAS, you can ignore this email and nothing will happen.\n\nNeed help? Write to us at {{helpEmail}}.\n\nThe PALTAS team',
  updated_at = now()
WHERE id = 'tpl_default_signup_verify_email' AND org_id IS NULL
  AND body = E'Hello {{name}},\n\nYour {{productName}} trial for {{orgName}} is ready. Verify your e-mail address with this link (valid until {{expiresAt}}):\n\n{{link}}\n\nUpgrading, paying and inviting your team need a verified address.';

UPDATE notification_templates SET subject = 'Your trial ends in {{daysLeftText}}',
  body = E'Hello {{name}},\n\nThank you for trying {{productName}} with PALTAS. Your free trial for {{orgName}} ends on {{trialEnds}}.\n\nTo keep working without a break, choose a plan here:\n\n{{link}}\n\nIf you need a little longer, your workspace keeps working for {{graceDays}} more day(s) after the trial. After that it becomes read-only: every record is kept safe and you can still export everything.\n\nNeed help? Write to us at {{helpEmail}}.\n\nThe PALTAS team',
  updated_at = now()
WHERE id = 'tpl_default_trial_reminder_email' AND org_id IS NULL
  AND body = E'Hello {{name}},\n\nYour {{productName}} trial for {{orgName}} ends on {{trialEnds}}. After {{graceDays}} grace day(s) the workspace becomes read-only: every record is kept and can be exported. Choose a plan any time to keep working.';

UPDATE notification_templates SET subject = 'Your PALTAS trial has ended — your records are safe',
  body = E'Hello {{name}},\n\nYour {{productName}} free trial for {{orgName}} has ended. Thank you for giving PALTAS a try.\n\nEverything you added is kept safe: you can still sign in, read your records and export them. To make changes again, choose a plan here:\n\n{{link}}\n\nNeed help? Write to us at {{helpEmail}}.\n\nThe PALTAS team',
  updated_at = now()
WHERE id = 'tpl_default_trial_ended_email' AND org_id IS NULL
  AND body = E'Hello {{name}},\n\nThe {{productName}} trial for {{orgName}} has ended. Your records are kept and readable, and you can export them. Choose a plan to make changes again.';

UPDATE notification_templates SET subject = 'Please confirm your email to keep using PALTAS',
  body = E'Hello {{name}},\n\nWe have paused the {{orgName}} workspace because your email address was not confirmed within {{days}} day(s). Nothing is lost: all your records are kept safe.\n\nTo continue, sign in and choose "Send the link again", then open the new link:\n\n{{link}}\n\nNeed help? Write to us at {{helpEmail}}.\n\nThe PALTAS team',
  updated_at = now()
WHERE id = 'tpl_default_signup_suspended_email' AND org_id IS NULL
  AND body = E'Hello {{name}},\n\nYour e-mail address was not verified within {{days}} day(s), so the {{orgName}} workspace is suspended. Your records are kept. Sign in and ask for a new verification link to continue.';
