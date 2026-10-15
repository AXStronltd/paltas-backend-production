-- Platform operations: the scheduler, the notifications outbox, payment provider references and bank statement
-- imports, organisation suspension, catalogue price changes with approval, and the rule that PALTAS staff never
-- belong to a client organisation. Never edit once applied — add a new numbered file.

-- ---------------------------------------------------------------- PALTAS staff are never members of an organisation
-- (a property owner or any client account never becomes Super Admin, and a Super Admin never joins a client)
CREATE FUNCTION staff_never_members() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'memberships' THEN
    IF EXISTS (SELECT 1 FROM users WHERE id = NEW.user_id AND staff_role IS NOT NULL) THEN
      RAISE EXCEPTION 'A PALTAS staff account cannot join a client organisation' USING ERRCODE = 'PA003';
    END IF;
  ELSIF NEW.staff_role IS NOT NULL AND EXISTS (SELECT 1 FROM memberships WHERE user_id = NEW.id) THEN
    RAISE EXCEPTION 'A member of a client organisation cannot become PALTAS staff' USING ERRCODE = 'PA003';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER memberships_no_staff BEFORE INSERT OR UPDATE ON memberships
  FOR EACH ROW EXECUTE FUNCTION staff_never_members();
CREATE TRIGGER users_staff_not_member BEFORE INSERT OR UPDATE OF staff_role ON users
  FOR EACH ROW EXECUTE FUNCTION staff_never_members();

-- ---------------------------------------------------------------- organisation suspension (by PALTAS, with a reason)
ALTER TABLE organisations ADD COLUMN suspended_at timestamptz;
ALTER TABLE organisations ADD COLUMN suspended_reason text;
ALTER TABLE organisations ADD CONSTRAINT organisations_suspension_reason
  CHECK ((suspended_at IS NULL) = (suspended_reason IS NULL));

-- every suspension and reactivation, append-only
CREATE TABLE org_suspensions (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id      text NOT NULL REFERENCES organisations(id),
  action      text NOT NULL CHECK (action IN ('suspend', 'reactivate')),
  reason      text NOT NULL CHECK (length(reason) >= 5),
  by_user     text NOT NULL REFERENCES users(id),
  at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX org_suspensions_org ON org_suspensions (org_id, id DESC);
CREATE TRIGGER org_suspensions_no_update BEFORE UPDATE OR DELETE ON org_suspensions
  FOR EACH ROW EXECUTE FUNCTION audit_log_is_append_only();

-- ---------------------------------------------------------------- catalogue price changes: requested, approved by a second person
CREATE TABLE catalogue_price_changes (
  id            text PRIMARY KEY,
  target_kind   text NOT NULL CHECK (target_kind IN ('plan', 'module')),
  target_id     text NOT NULL,
  before        jsonb NOT NULL,           -- prices when requested
  proposed      jsonb NOT NULL,           -- { baseMinor, extraBuildingMinor, priceMinor, currency } as asked
  reason        text NOT NULL CHECK (length(reason) >= 5),
  status        text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'applied', 'rejected')),
  requested_by  text NOT NULL REFERENCES users(id),
  requested_at  timestamptz NOT NULL DEFAULT now(),
  decided_by    text REFERENCES users(id),
  decided_at    timestamptz,
  decision_note text,
  applied       jsonb,                    -- prices after the change was applied
  -- the person who asked for a price change can never approve or reject it
  CONSTRAINT price_change_needs_second_person CHECK (decided_by IS NULL OR decided_by <> requested_by),
  CHECK ((status = 'pending') = (decided_by IS NULL)),
  CHECK ((status = 'applied') = (applied IS NOT NULL))
);
-- at most one open request per plan or module, so two approvals can never race on the same price
CREATE UNIQUE INDEX catalogue_price_changes_one_open ON catalogue_price_changes (target_kind, target_id)
  WHERE status = 'pending';

-- ---------------------------------------------------------------- scheduler
-- One row per schedule: platform jobs (org_id NULL) are created at start-up from their definitions; organisation
-- jobs (e.g. a hotel's night audit, monthly rent invoicing) are created by their product.
CREATE TABLE sched_jobs (
  id             text PRIMARY KEY,
  key            text NOT NULL,                       -- handler key, e.g. 'platform.sessions.cleanup'
  org_id         text REFERENCES organisations(id),
  target_id      text,                                -- e.g. the hotel property
  label          text NOT NULL,
  cron           text NOT NULL,                       -- minute hour day-of-month month day-of-week
  timezone       text NOT NULL DEFAULT 'UTC',
  status         text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused')),
  paused_reason  text,
  next_run_at    timestamptz,
  last_run_at    timestamptz,
  last_status    text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CHECK ((status = 'paused') = (paused_reason IS NOT NULL))
);
CREATE UNIQUE INDEX sched_jobs_once ON sched_jobs (key, COALESCE(org_id, ''), COALESCE(target_id, ''));
CREATE INDEX sched_jobs_due ON sched_jobs (next_run_at) WHERE status = 'active';

-- One row per (job, period): a period runs at most once successfully, whatever the number of servers or retries.
CREATE TABLE sched_runs (
  id            text PRIMARY KEY,
  job_id        text NOT NULL REFERENCES sched_jobs(id),
  org_id        text REFERENCES organisations(id),
  period        text NOT NULL,                        -- local fire time "YYYY-MM-DDTHH:MM", or "manual:<moment>"
  trigger       text NOT NULL CHECK (trigger IN ('schedule', 'manual')),
  status        text NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'skipped')),
  due_at        timestamptz NOT NULL,
  scheduled_for timestamptz NOT NULL,
  attempts      integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts  integer NOT NULL CHECK (max_attempts >= 1),
  lease_owner   text,
  lease_until   timestamptz,
  heartbeat_at  timestamptz,
  started_at    timestamptz,
  finished_at   timestamptz,
  summary       text,
  error         text,
  requested_by  text REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (job_id, period),
  CHECK (status <> 'running' OR (lease_owner IS NOT NULL AND lease_until IS NOT NULL)),
  CHECK (attempts <= max_attempts)
);
CREATE INDEX sched_runs_due ON sched_runs (due_at) WHERE status IN ('queued', 'running');
CREATE INDEX sched_runs_job ON sched_runs (job_id, created_at DESC);

-- ---------------------------------------------------------------- notifications outbox
-- Messages are RECORDED here; a provider adapter queues them; only a provider's signed delivery report makes one
-- "sent" or "failed". A test adapter never makes anything "sent" (enforced below).
CREATE TABLE notification_senders (
  org_id        text NOT NULL REFERENCES organisations(id),
  channel       text NOT NULL CHECK (channel IN ('email', 'sms', 'whatsapp', 'push')),
  provider      text NOT NULL DEFAULT 'test',
  from_name     text NOT NULL DEFAULT '',
  from_address  text NOT NULL DEFAULT '',
  reply_to      text NOT NULL DEFAULT '',
  enabled       boolean NOT NULL DEFAULT true,
  updated_by    text REFERENCES users(id),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, channel)
);

-- org_id NULL = PALTAS default template, used when the organisation has none of its own
CREATE TABLE notification_templates (
  id          text PRIMARY KEY,
  org_id      text REFERENCES organisations(id),
  key         text NOT NULL CHECK (key ~ '^[a-z0-9][a-z0-9._-]{1,79}$'),
  channel     text NOT NULL CHECK (channel IN ('email', 'sms', 'whatsapp', 'push')),
  subject     text NOT NULL DEFAULT '',
  body        text NOT NULL CHECK (length(body) BETWEEN 1 AND 10000),
  updated_by  text REFERENCES users(id),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX notification_templates_once ON notification_templates (COALESCE(org_id, ''), key, channel);

INSERT INTO notification_templates (id, org_id, key, channel, subject, body) VALUES
  ('tpl_default_notice_email', NULL, 'generic.notice', 'email', '{{subject}}', E'Hello {{name}},\n\n{{message}}\n\n{{orgName}}'),
  ('tpl_default_notice_sms', NULL, 'generic.notice', 'sms', '', '{{orgName}}: {{message}}'),
  ('tpl_default_notice_whatsapp', NULL, 'generic.notice', 'whatsapp', '', E'Hello {{name}}, {{message}}\n— {{orgName}}'),
  ('tpl_default_notice_push', NULL, 'generic.notice', 'push', '{{subject}}', '{{message}}');

-- consent history per address, channel and purpose; the latest entry decides
CREATE TABLE notification_consents (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id       text NOT NULL REFERENCES organisations(id),
  channel      text NOT NULL CHECK (channel IN ('email', 'sms', 'whatsapp', 'push')),
  address      text NOT NULL,
  purpose      text NOT NULL CHECK (purpose IN ('transactional', 'marketing')),
  granted      boolean NOT NULL,
  source       text NOT NULL CHECK (length(source) >= 3),     -- e.g. "signed lease form", "STOP reply"
  recorded_by  text REFERENCES users(id),
  recorded_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notification_consents_lookup ON notification_consents (org_id, channel, address, purpose, id DESC);
CREATE TRIGGER notification_consents_no_update BEFORE UPDATE OR DELETE ON notification_consents
  FOR EACH ROW EXECUTE FUNCTION audit_log_is_append_only();

CREATE TABLE notifications (
  id                   text PRIMARY KEY,
  org_id               text NOT NULL REFERENCES organisations(id),
  channel              text NOT NULL CHECK (channel IN ('email', 'sms', 'whatsapp', 'push')),
  to_address           text NOT NULL,
  category             text NOT NULL CHECK (category IN ('transactional', 'marketing')),
  template_key         text,
  subject              text NOT NULL DEFAULT '',
  body                 text NOT NULL,
  status               text NOT NULL CHECK (status IN ('recorded', 'queued', 'sent', 'failed', 'suppressed')),
  status_note          text NOT NULL DEFAULT '',
  provider             text,
  provider_message_id  text,
  source               text NOT NULL,                  -- area that recorded it, e.g. 'hotel', 'property', 'platform'
  source_ref           text,                           -- idempotency key within the source
  attempts             integer NOT NULL DEFAULT 0,
  created_by           text REFERENCES users(id),
  created_at           timestamptz NOT NULL DEFAULT now(),
  queued_at            timestamptz,
  sent_at              timestamptz,
  failed_at            timestamptz,
  -- "sent" only ever comes from a real provider's report, never from the test adapter
  CONSTRAINT notification_sent_needs_provider CHECK (
    status <> 'sent' OR (provider IS NOT NULL AND provider <> 'test' AND provider_message_id IS NOT NULL)),
  CHECK (status NOT IN ('queued', 'sent') OR provider IS NOT NULL)
);
CREATE UNIQUE INDEX notifications_source_once ON notifications (org_id, source, source_ref) WHERE source_ref IS NOT NULL;
CREATE UNIQUE INDEX notifications_provider_msg ON notifications (provider, provider_message_id)
  WHERE provider_message_id IS NOT NULL;
CREATE INDEX notifications_org ON notifications (org_id, created_at DESC);
CREATE INDEX notifications_recorded ON notifications (created_at) WHERE status = 'recorded';

-- delivery reports received from providers (signed webhook); the provider's event id makes them idempotent
CREATE TABLE notification_events (
  id                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  notification_id    text NOT NULL REFERENCES notifications(id),
  org_id             text NOT NULL REFERENCES organisations(id),
  provider           text NOT NULL,
  provider_event_id  text NOT NULL,
  status             text NOT NULL,
  detail             text NOT NULL DEFAULT '',
  received_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_event_id)
);

-- ---------------------------------------------------------------- payment provider references and callbacks
-- What a payment is for, by the reference the payer quotes (M-Pesa account number, card PSP reference, bank
-- transfer reference). Registered by the product (or core for subscription invoices) when it asks for money.
CREATE TABLE payment_references (
  id            text PRIMARY KEY,
  org_id        text REFERENCES organisations(id),       -- NULL: a PALTAS subscription invoice
  reference     text NOT NULL CHECK (reference ~ '^[A-Za-z0-9][A-Za-z0-9._/-]{2,59}$'),
  type          text NOT NULL,                           -- payment type handled by core or a product
  invoice_id    text,
  data          jsonb NOT NULL DEFAULT '{}',
  amount_minor  bigint NOT NULL CHECK (amount_minor > 0),
  currency      char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  status        text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'settled', 'cancelled')),
  created_by    text REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  -- a client organisation can never register a reference that pays a PALTAS invoice
  CHECK (org_id IS NULL OR type <> 'subscription.payment')
);
CREATE UNIQUE INDEX payment_references_ref ON payment_references (lower(reference));

-- every provider callback as received (native shape), with what it was translated into and the outcome
CREATE TABLE provider_callbacks (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  provider     text NOT NULL,
  kind         text NOT NULL CHECK (kind IN ('mpesa_stk', 'mpesa_c2b', 'card')),
  external_id  text NOT NULL,
  payload      jsonb NOT NULL,
  event        jsonb,
  result       text NOT NULL,
  received_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX provider_callbacks_ext ON provider_callbacks (provider, kind, external_id);

-- ---------------------------------------------------------------- bank statement imports
CREATE TABLE bank_statements (
  id             text PRIMARY KEY,
  org_id         text REFERENCES organisations(id),      -- NULL: PALTAS's own account (subscription invoices)
  account_label  text NOT NULL,
  currency       char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  file_sha256    char(64) NOT NULL,
  line_count     integer NOT NULL,
  imported_by    text NOT NULL REFERENCES users(id),
  imported_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX bank_statements_once ON bank_statements (COALESCE(org_id, ''), file_sha256);

CREATE TABLE bank_statement_lines (
  id                text PRIMARY KEY,
  statement_id      text NOT NULL REFERENCES bank_statements(id),
  org_id            text REFERENCES organisations(id),
  line_no           integer NOT NULL,
  value_date        date NOT NULL,
  amount_minor      bigint NOT NULL,
  currency          char(3) NOT NULL,
  bank_ref          text NOT NULL,
  description       text NOT NULL DEFAULT '',
  status            text NOT NULL CHECK (status IN ('unmatched', 'suggested', 'confirmed', 'ignored', 'duplicate', 'outgoing')),
  suggestions       jsonb NOT NULL DEFAULT '[]',
  imported_by       text NOT NULL REFERENCES users(id),
  decided_by        text REFERENCES users(id),
  decided_at        timestamptz,
  decision_reason   text,
  matched_reference text,
  payment_event_id  text REFERENCES payment_events(id),
  result            text,
  UNIQUE (statement_id, line_no),
  -- the person who imported a statement never confirms its matches
  CONSTRAINT bank_match_needs_second_person CHECK (decided_by IS NULL OR decided_by <> imported_by),
  CHECK ((status = 'confirmed') = (payment_event_id IS NOT NULL))
);
-- the same bank transaction (by its bank reference) is only ever applied once per account holder
CREATE UNIQUE INDEX bank_lines_ref_once ON bank_statement_lines (COALESCE(org_id, ''), lower(bank_ref))
  WHERE status NOT IN ('duplicate', 'outgoing');
