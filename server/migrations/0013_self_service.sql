-- Self-service sign-up and ONE platform-wide trial policy for every product (property, developer, hotel, security,
-- agency): the policy row and its history, trial terms on each subscription (grace), e-mail verification, the
-- one-trial-per-business registry, sign-up requests (with the staff review of blocked repeats) and self-service
-- upgrades. Never edit once applied — add a new numbered file.

-- ---------------------------------------------------------------- the platform trial policy (one row) and its history
-- Read by every path that starts a trial: self-service sign-up, staff onboarding (create organisation, add product),
-- a second product added by the customer, and the agency "For Business" approval. Changed only by a Super Admin
-- (audited, every version kept below). The defaults equal entitlements.DEFAULT_TRIAL_POLICY in the contracts, so the
-- browser rules show the same numbers (checked by server/test/signup.policy.test.ts).
CREATE TABLE trial_policy (
  id                  smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  version             integer NOT NULL CHECK (version >= 1),
  trial_days          integer NOT NULL CHECK (trial_days BETWEEN 1 AND 90),
  -- after the last trial day the workspace keeps working this many days, then becomes read-only
  grace_days          integer NOT NULL CHECK (grace_days BETWEEN 0 AND 30),
  -- reminders recorded in the outbox this many days before the trial ends (T-7, T-3, T-1)
  reminder_days       integer[] NOT NULL CHECK (cardinality(reminder_days) <= 10
                        AND 1 <= ALL (reminder_days) AND 90 >= ALL (reminder_days)),
  -- a self-service account whose e-mail is still unverified this many days after sign-up is suspended
  verify_within_days  integer NOT NULL CHECK (verify_within_days BETWEEN 1 AND 60),
  -- how long one e-mail verification link stays valid
  verify_link_hours   integer NOT NULL CHECK (verify_link_hours BETWEEN 1 AND 168),
  -- one trial per business: an earlier trial with the same identifier inside this window blocks a new one
  repeat_window_days  integer NOT NULL CHECK (repeat_window_days BETWEEN 0 AND 3650),
  repeat_match        text[] NOT NULL CHECK (repeat_match <@ ARRAY['email', 'phone', 'company']::text[]),
  -- a further product on an organisation: its own trial of trial_days (once per product), or paid from day one
  second_product      text NOT NULL CHECK (second_product IN ('own_trial', 'no_trial')),
  -- what happens at expiry: fixed by design (read-only, records kept); export can be allowed or not
  at_expiry           text NOT NULL DEFAULT 'read_only' CHECK (at_expiry = 'read_only'),
  keep_records        boolean NOT NULL DEFAULT true CHECK (keep_records),
  export_allowed      boolean NOT NULL DEFAULT true,
  updated_by          text REFERENCES users(id),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
INSERT INTO trial_policy (id, version, trial_days, grace_days, reminder_days, verify_within_days, verify_link_hours,
  repeat_window_days, repeat_match, second_product)
VALUES (1, 1, 30, 7, ARRAY[7, 3, 1], 7, 48, 365, ARRAY['email', 'phone', 'company'], 'own_trial');

CREATE TABLE trial_policy_history (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  version     integer NOT NULL UNIQUE,
  policy      jsonb NOT NULL,
  reason      text NOT NULL CHECK (length(reason) >= 5),
  changed_by  text REFERENCES users(id),                -- NULL only for the first version (this migration)
  changed_at  timestamptz NOT NULL DEFAULT now(),
  CHECK (changed_by IS NOT NULL OR version = 1)
);
INSERT INTO trial_policy_history (version, policy, reason)
SELECT version, jsonb_build_object('trialDays', trial_days, 'graceDays', grace_days, 'reminderDays', to_jsonb(reminder_days),
  'verifyWithinDays', verify_within_days, 'verifyLinkHours', verify_link_hours, 'repeatWindowDays', repeat_window_days,
  'repeatMatch', to_jsonb(repeat_match), 'secondProduct', second_product, 'atExpiry', at_expiry,
  'keepRecords', keep_records, 'exportAllowed', export_allowed), 'Initial platform trial policy (migration 0013)'
FROM trial_policy;
CREATE TRIGGER trial_policy_history_no_update BEFORE UPDATE OR DELETE ON trial_policy_history
  FOR EACH ROW EXECUTE FUNCTION audit_log_is_append_only();

-- per-plan trial days are no longer read anywhere: the policy decides for every plan and product
COMMENT ON COLUMN catalogue_plans.trial_days IS
  'Not used since migration 0013 — the platform trial policy (trial_policy) sets the trial length for every plan';

-- ---------------------------------------------------------------- trial terms kept on each subscription
-- A trial keeps the terms it started with (a later policy change applies to new trials only): its end date
-- (trial_ends, as before), its grace days and the policy version.
ALTER TABLE subscriptions ADD COLUMN grace_days integer NOT NULL DEFAULT 0 CHECK (grace_days BETWEEN 0 AND 30);
ALTER TABLE subscriptions ADD COLUMN trial_started date;
ALTER TABLE subscriptions ADD COLUMN trial_policy_version integer;

-- the public marketplace's usable check follows the rules: a trial is usable through its grace days
CREATE OR REPLACE FUNCTION mkt_org_usable(p_org text, p_product text, p_today date) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM subscriptions s
    WHERE s.org_id = p_org AND s.product = p_product
      AND (s.status = 'active' OR (s.status = 'trial' AND (s.trial_ends IS NULL OR s.trial_ends + s.grace_days >= p_today)))
      AND NOT EXISTS (SELECT 1 FROM subscription_pending p
                      WHERE p.org_id = s.org_id AND p.product = s.product AND p.type = 'cancel' AND p.effective <= p_today))
$$;

-- ---------------------------------------------------------------- e-mail verification
ALTER TABLE users ADD COLUMN email_verified_at timestamptz;

-- only the SHA-256 of a link's token is stored; the link itself is the recorded outbox message (never "sent" here)
CREATE TABLE email_verifications (
  id               text PRIMARY KEY,
  org_id           text NOT NULL REFERENCES organisations(id),
  user_id          text NOT NULL REFERENCES users(id),
  email            text NOT NULL,
  token_hash       char(64) NOT NULL UNIQUE,
  expires_at       timestamptz NOT NULL,
  used_at          timestamptz,
  superseded_at    timestamptz,
  notification_id  text REFERENCES notifications(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  CHECK (used_at IS NULL OR superseded_at IS NULL)
);
CREATE INDEX email_verifications_user ON email_verifications (user_id, created_at DESC);

-- ---------------------------------------------------------------- one trial per business
-- Every trial ever started, by whichever path. Append-only: the window check reads it, nothing rewrites it.
CREATE TABLE trial_registry (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id           text NOT NULL REFERENCES organisations(id),
  product          text NOT NULL,
  company_key      text NOT NULL,                       -- normalised company name (see core/signup/identity.ts)
  country          text NOT NULL,                       -- lower case
  email            text,                                -- lower case
  phone            text,                                -- international form, +2547…
  started_on       date NOT NULL,
  source           text NOT NULL CHECK (source IN ('signup', 'staff', 'second_product')),
  override_reason  text,
  override_by      text REFERENCES users(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  CHECK ((override_reason IS NULL) = (override_by IS NULL))
);
CREATE INDEX trial_registry_company ON trial_registry (company_key, country, started_on);
CREATE INDEX trial_registry_email ON trial_registry (email, started_on) WHERE email IS NOT NULL;
CREATE INDEX trial_registry_phone ON trial_registry (phone, started_on) WHERE phone IS NOT NULL;
CREATE TRIGGER trial_registry_no_update BEFORE UPDATE OR DELETE ON trial_registry
  FOR EACH ROW EXECUTE FUNCTION audit_log_is_append_only();

-- ---------------------------------------------------------------- self-service sign-up requests
-- Every request that passed validation, whatever its outcome (the public answer is the same for all of them):
--   created         organisation, administrator and trial created
--   duplicate       the e-mail already has a PALTAS account, or the organisation name is taken: nothing created
--   blocked_repeat  an earlier trial of the same business inside the policy window: waits for PALTAS staff
--   allowed         a blocked request PALTAS staff allowed, with a reason: organisation created then
--   declined        a blocked request PALTAS staff declined, with a reason
CREATE TABLE org_signups (
  id                      text PRIMARY KEY,
  status                  text NOT NULL CHECK (status IN ('created', 'duplicate', 'blocked_repeat', 'allowed', 'declined')),
  org_id                  text REFERENCES organisations(id),
  user_id                 text REFERENCES users(id),
  company                 text NOT NULL,
  company_key             text NOT NULL,
  country                 text NOT NULL,
  timezone                text NOT NULL,
  product                 text NOT NULL,
  plan_id                 text NOT NULL REFERENCES catalogue_plans(id),
  admin_name              text NOT NULL,
  email                   text NOT NULL,
  phone                   text NOT NULL,
  -- scrypt hash of the chosen password, kept ONLY while a blocked request waits for a staff decision
  password_hash           text,
  terms_version           text NOT NULL,
  terms_accepted_at       timestamptz NOT NULL,
  ip                      text NOT NULL,
  signed_up_on            date NOT NULL,
  opened_on               date,                          -- the day the organisation and trial were created
  matched                 jsonb NOT NULL DEFAULT '[]',   -- why a request was a duplicate or a repeat (staff only)
  decided_by              text REFERENCES users(id),
  decided_at              timestamptz,
  decision_reason         text,
  unverified_suspended_at timestamptz,                   -- suspended by the scheduler: e-mail not verified in time
  suspended_products      text[] NOT NULL DEFAULT '{}',
  created_at              timestamptz NOT NULL DEFAULT now(),
  CHECK ((status IN ('created', 'allowed')) = (org_id IS NOT NULL AND user_id IS NOT NULL AND opened_on IS NOT NULL)),
  CHECK (password_hash IS NULL OR status = 'blocked_repeat'),
  CHECK ((status IN ('allowed', 'declined')) = (decided_by IS NOT NULL AND length(decision_reason) >= 5))
);
CREATE INDEX org_signups_ip ON org_signups (ip, created_at);
CREATE INDEX org_signups_email ON org_signups (email, created_at);
CREATE INDEX org_signups_status ON org_signups (status, created_at);
CREATE UNIQUE INDEX org_signups_org ON org_signups (org_id) WHERE org_id IS NOT NULL;

-- ---------------------------------------------------------------- self-service upgrades (trial or lapsed → paid)
-- The order and its invoice are the existing billing records (billing_purchases, billing_invoices); this row keeps
-- how the customer chose to pay. The subscription becomes active only when that invoice is paid by a verified
-- payment event (provider signature or a bank reference recorded by PALTAS staff).
CREATE TABLE subscription_upgrades (
  id            text PRIMARY KEY,
  org_id        text NOT NULL REFERENCES organisations(id),
  product       text NOT NULL,
  plan_id       text NOT NULL REFERENCES catalogue_plans(id),
  frequency     text NOT NULL CHECK (frequency IN ('monthly', 'quarterly', 'yearly')),
  method        text NOT NULL CHECK (method IN ('provider', 'bank_transfer')),
  purchase_id   text NOT NULL UNIQUE REFERENCES billing_purchases(id),
  invoice_id    text NOT NULL REFERENCES billing_invoices(id),
  requested_by  text NOT NULL REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX subscription_upgrades_org ON subscription_upgrades (org_id, product, created_at DESC);

-- ---------------------------------------------------------------- PALTAS default message wording
INSERT INTO notification_templates (id, org_id, key, channel, subject, body) VALUES
  ('tpl_default_signup_verify_email', NULL, 'signup.verify', 'email', 'Verify your e-mail address for PALTAS',
   E'Hello {{name}},\n\nYour {{productName}} trial for {{orgName}} is ready. Verify your e-mail address with this link (valid until {{expiresAt}}):\n\n{{link}}\n\nUpgrading, paying and inviting your team need a verified address.'),
  ('tpl_default_trial_reminder_email', NULL, 'trial.reminder', 'email', 'Your PALTAS trial ends in {{daysLeft}} day(s)',
   E'Hello {{name}},\n\nYour {{productName}} trial for {{orgName}} ends on {{trialEnds}}. After {{graceDays}} grace day(s) the workspace becomes read-only: every record is kept and can be exported. Choose a plan any time to keep working.'),
  ('tpl_default_trial_ended_email', NULL, 'trial.ended', 'email', 'Your PALTAS trial has ended',
   E'Hello {{name}},\n\nThe {{productName}} trial for {{orgName}} has ended. Your records are kept and readable, and you can export them. Choose a plan to make changes again.'),
  ('tpl_default_signup_suspended_email', NULL, 'signup.unverified', 'email', 'Your PALTAS workspace is suspended',
   E'Hello {{name}},\n\nYour e-mail address was not verified within {{days}} day(s), so the {{orgName}} workspace is suspended. Your records are kept. Sign in and ask for a new verification link to continue.');
