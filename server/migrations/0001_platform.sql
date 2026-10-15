-- PALTAS platform core: organisations, people, sign-in, catalogue, subscriptions, billing, payments, audit.
-- Conventions:
--   * every business table carries org_id and every query filters by it (organisation isolation);
--   * money is bigint minor units (cents) with a 3-letter currency;
--   * dates are `date`, moments are `timestamptz`;
--   * this file is never edited once applied — later changes are new numbered files.

-- ---------------------------------------------------------------- organisations and people
CREATE TABLE organisations (
  id            text PRIMARY KEY,
  name          text NOT NULL,
  legal_name    text NOT NULL,
  country       text NOT NULL,
  currency      char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  timezone      text NOT NULL DEFAULT 'UTC',
  demo          boolean NOT NULL DEFAULT false,
  discount_pct  numeric(5,2) NOT NULL DEFAULT 0 CHECK (discount_pct BETWEEN 0 AND 100),
  terms_note    text NOT NULL DEFAULT '',
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX organisations_name_key ON organisations (lower(name));

CREATE TABLE users (
  id                    text PRIMARY KEY,
  email                 text NOT NULL,
  name                  text NOT NULL,
  password_hash         text NOT NULL,
  must_change_password  boolean NOT NULL DEFAULT false,
  mfa_secret_sealed     text,             -- AES-GCM sealed authenticator secret (see lib/secret-box.ts)
  mfa_pending_sealed    text,             -- set while two-factor is being turned on
  staff_role            text CHECK (staff_role IN ('super_admin', 'support')),  -- NULL = not PALTAS staff
  active                boolean NOT NULL DEFAULT true,
  failed_count          integer NOT NULL DEFAULT 0,
  locked_until          timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  -- PALTAS staff must always have a second factor
  CONSTRAINT staff_need_mfa CHECK (staff_role IS NULL OR mfa_secret_sealed IS NOT NULL)
);
CREATE UNIQUE INDEX users_email_key ON users (lower(email));

CREATE TABLE memberships (
  org_id      text NOT NULL REFERENCES organisations(id),
  user_id     text NOT NULL REFERENCES users(id),
  role        text NOT NULL,
  status      text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, user_id)
);
CREATE INDEX memberships_user ON memberships (user_id);

-- only the SHA-256 of a session token is stored
CREATE TABLE sessions (
  token_hash  char(64) PRIMARY KEY,
  user_id     text NOT NULL REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  ip          text
);
CREATE INDEX sessions_user ON sessions (user_id);

-- ---------------------------------------------------------------- catalogue (PALTAS configuration, never hard-coded prices)
CREATE TABLE catalogue_modules (
  key          text PRIMARY KEY,
  name         text NOT NULL,
  products     text[] NOT NULL DEFAULT '{}',
  deps         text[] NOT NULL DEFAULT '{}',
  excludes     text[] NOT NULL DEFAULT '{}',
  price_minor  bigint CHECK (price_minor > 0),
  price_ccy    char(3),
  per          text NOT NULL DEFAULT 'month',
  scope        text NOT NULL DEFAULT 'product' CHECK (scope IN ('product', 'organisation')),
  available    boolean NOT NULL DEFAULT true,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CHECK ((price_minor IS NULL) = (price_ccy IS NULL))
);

CREATE TABLE catalogue_plans (
  id                    text PRIMARY KEY,
  name                  text NOT NULL,
  tier                  text CHECK (tier IN ('Standard', 'Pro', 'Enterprise')),
  product               text NOT NULL,
  modules               text[] NOT NULL DEFAULT '{}',
  buildings_included    integer NOT NULL DEFAULT 0 CHECK (buildings_included >= 0),
  base_minor            bigint CHECK (base_minor > 0),
  extra_building_minor  bigint CHECK (extra_building_minor > 0),
  currency              char(3),
  frequency             text NOT NULL DEFAULT 'monthly' CHECK (frequency IN ('monthly', 'quarterly', 'yearly')),
  trial_days            integer NOT NULL DEFAULT 30 CHECK (trial_days BETWEEN 0 AND 90),
  tax_pct               numeric(5,2) CHECK (tax_pct BETWEEN 0 AND 100),
  tax_note              text NOT NULL DEFAULT '',
  cap_sites             integer,
  cap_units             integer,
  active                boolean NOT NULL DEFAULT true,
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CHECK ((base_minor IS NULL AND extra_building_minor IS NULL) OR currency IS NOT NULL)
);

-- ---------------------------------------------------------------- subscriptions: one per organisation AND product
CREATE TABLE subscriptions (
  org_id              text NOT NULL REFERENCES organisations(id),
  product             text NOT NULL CHECK (product IN ('property', 'developer', 'agency', 'hotel', 'security')),
  plan_id             text REFERENCES catalogue_plans(id),
  status              text NOT NULL CHECK (status IN ('trial', 'active', 'suspended', 'expired')),
  trial_ends          date,
  anchor              date,             -- billing anniversary
  buildings_extra     integer NOT NULL DEFAULT 0 CHECK (buildings_extra >= 0),
  buildings_override  integer CHECK (buildings_override >= 0),
  created_at          timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, product)
);

CREATE TABLE subscription_addons (
  org_id      text NOT NULL,
  product     text NOT NULL,
  module_key  text NOT NULL REFERENCES catalogue_modules(key),
  since       date NOT NULL,
  PRIMARY KEY (org_id, product, module_key),
  FOREIGN KEY (org_id, product) REFERENCES subscriptions(org_id, product)
);

-- modules PALTAS has switched off for one subscription
CREATE TABLE subscription_disabled (
  org_id      text NOT NULL,
  product     text NOT NULL,
  module_key  text NOT NULL REFERENCES catalogue_modules(key),
  PRIMARY KEY (org_id, product, module_key),
  FOREIGN KEY (org_id, product) REFERENCES subscriptions(org_id, product)
);

-- changes that take effect later: add-on cancellation, plan downgrade, cancellation
CREATE TABLE subscription_pending (
  id          text PRIMARY KEY,
  org_id      text NOT NULL,
  product     text NOT NULL,
  type        text NOT NULL CHECK (type IN ('cancelAddon', 'plan', 'cancel')),
  module_key  text REFERENCES catalogue_modules(key),
  plan_id     text REFERENCES catalogue_plans(id),
  effective   date NOT NULL,
  reason      text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  created_by  text REFERENCES users(id),
  FOREIGN KEY (org_id, product) REFERENCES subscriptions(org_id, product),
  CHECK ((type = 'cancelAddon') = (module_key IS NOT NULL)),
  CHECK ((type = 'plan') = (plan_id IS NOT NULL))
);

-- ---------------------------------------------------------------- PALTAS subscription billing
CREATE TABLE billing_invoices (
  id              text PRIMARY KEY,
  org_id          text NOT NULL REFERENCES organisations(id),
  product         text NOT NULL,
  period_from     date NOT NULL,
  period_to       date NOT NULL,
  lines           jsonb NOT NULL,
  gross_minor     bigint NOT NULL,
  discount_minor  bigint NOT NULL,
  net_minor       bigint NOT NULL,
  tax_pct         numeric(5,2) NOT NULL,
  tax_minor       bigint NOT NULL,
  total_minor     bigint NOT NULL CHECK (total_minor >= 0),
  currency        char(3) NOT NULL,
  status          text NOT NULL CHECK (status IN ('Open', 'Payment failed', 'Paid', 'Void')),
  issued          date NOT NULL,
  due             date NOT NULL,
  attempts        integer NOT NULL DEFAULT 0,
  paid_at         timestamptz,
  paid_event      text,
  note            text NOT NULL DEFAULT '',
  CHECK (total_minor = net_minor + tax_minor),
  CHECK ((status = 'Paid') = (paid_event IS NOT NULL))
);
CREATE INDEX billing_invoices_org ON billing_invoices (org_id, product);

-- every payment event ever received, applied or not; the id makes delivery idempotent
CREATE TABLE payment_events (
  id            text PRIMARY KEY,           -- "<provider>:<provider event id>" or "manual:<bank ref>"
  provider      text NOT NULL,
  type          text NOT NULL,
  org_id        text REFERENCES organisations(id),
  target_id     text,
  status        text NOT NULL,
  amount_minor  bigint NOT NULL,
  currency      char(3) NOT NULL,
  ref           text NOT NULL DEFAULT '',
  manual        boolean NOT NULL DEFAULT false,
  recorded_by   text REFERENCES users(id),
  result        text NOT NULL,
  received_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX payment_events_ref ON payment_events (lower(ref));

CREATE TABLE billing_receipts (
  id            text PRIMARY KEY,
  org_id        text NOT NULL REFERENCES organisations(id),
  invoice_id    text NOT NULL UNIQUE REFERENCES billing_invoices(id),
  event_id      text NOT NULL REFERENCES payment_events(id),
  amount_minor  bigint NOT NULL,
  currency      char(3) NOT NULL,
  ref           text NOT NULL,
  manual        boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- an order for an add-on, plan, allowance or product; it starts only when its invoice is paid
CREATE TABLE billing_purchases (
  id           text PRIMARY KEY,
  org_id       text NOT NULL REFERENCES organisations(id),
  product      text NOT NULL,
  kind         text NOT NULL CHECK (kind IN ('addon', 'plan', 'allowance', 'product')),
  module_key   text REFERENCES catalogue_modules(key),
  plan_id      text REFERENCES catalogue_plans(id),
  invoice_id   text REFERENCES billing_invoices(id),
  status       text NOT NULL,
  total_minor  bigint NOT NULL,
  currency     char(3) NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  created_by   text REFERENCES users(id)
);
CREATE INDEX billing_purchases_invoice ON billing_purchases (invoice_id);

CREATE TABLE enterprise_enquiries (
  id          text PRIMARY KEY,
  org_id      text NOT NULL REFERENCES organisations(id),
  note        text NOT NULL,
  status      text NOT NULL DEFAULT 'New',
  created_at  timestamptz NOT NULL DEFAULT now(),
  created_by  text REFERENCES users(id)
);

-- document numbers (SUB-00001, RCPT-00001, JE-000001 …), per scope ('platform' or an organisation id)
CREATE TABLE counters (
  scope  text NOT NULL,
  name   text NOT NULL,
  value  bigint NOT NULL,
  PRIMARY KEY (scope, name)
);

-- ---------------------------------------------------------------- audit trail (append-only)
CREATE TABLE audit_log (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  at          timestamptz NOT NULL DEFAULT now(),
  actor_user  text,
  actor_role  text,
  org_id      text,
  action      text NOT NULL,
  target      text,
  detail      text NOT NULL DEFAULT '',
  before      jsonb,
  after       jsonb
);
CREATE INDEX audit_log_org ON audit_log (org_id, id DESC);

-- nobody, including the application, can change or delete an audit entry
CREATE FUNCTION audit_log_is_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'The audit log cannot be changed or deleted' USING ERRCODE = 'PA005';
END $$;
CREATE TRIGGER audit_log_no_update BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_is_append_only();
CREATE TRIGGER audit_log_no_truncate BEFORE TRUNCATE ON audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION audit_log_is_append_only();
