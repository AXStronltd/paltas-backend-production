-- Security Services (product "security"). Every table carries org_id; money is bigint minor units in the
-- organisation's currency; percentages are basis points (1 % = 100). Invoices, receipts, certificates, payroll and
-- costs post to the ONE ledger (journal_entries) through the ledger service; sec_ledger_links only says which
-- security record (site, client, kind) a posting belongs to, so the reports read exactly what Finance sees.
-- Invariants the database itself enforces:
--   * a guard never holds two overlapping shifts (exclusion constraint sec_guard_not_double_booked);
--   * the occurrence book is append-only (no UPDATE, DELETE or TRUNCATE); corrections are new rows;
--   * an incident's facts never change, it is never deleted, and its reporter cannot close it;
--   * whoever recorded or corrected attendance cannot approve that timesheet;
--   * whoever prepared a payroll run cannot approve it;
--   * one active contract per site; one open issue per equipment item; access decisions are append-only.

CREATE EXTENSION IF NOT EXISTS btree_gist;

-- ---------------------------------------------------------------- catalogue: security plans (DEMO prices)
-- KES prices are PALTAS demo configuration, to be confirmed before any customer is billed. Super Admin changes them
-- through the admin API; nothing in the code reads a price. "buildings" for this product are sites.
INSERT INTO catalogue_plans (id, name, tier, product, modules, buildings_included, base_minor, extra_building_minor,
  currency, trial_days, tax_pct, tax_note, cap_sites, cap_units)
VALUES
  ('SEC-STD', 'Security Services — Standard', 'Standard', 'security', ARRAY['finance', 'docs'], 5, 2500000, 300000,
   'KES', 30, 16, 'Demo configuration — VAT as configured by PALTAS; confirm with your tax adviser', 5, 150),
  ('SEC-PRO', 'Security Services — Pro', 'Pro', 'security', ARRAY['finance', 'payments', 'docs', 'automation'], 25,
   7500000, 250000, 'KES', 30, 16, 'Demo configuration — VAT as configured by PALTAS; confirm with your tax adviser',
   25, 2000)
ON CONFLICT (id) DO NOTHING;

-- ---------------------------------------------------------------- settings and payroll configuration
CREATE TABLE sec_settings (
  org_id                  text PRIMARY KEY REFERENCES organisations(id),
  late_fee_bp             integer CHECK (late_fee_bp BETWEEN 0 AND 10000),   -- null: not configured
  licence_alert_days      integer NOT NULL DEFAULT 30 CHECK (licence_alert_days > 0),
  min_rest_hours          integer NOT NULL DEFAULT 8 CHECK (min_rest_hours >= 0),
  clock_in_early_minutes  integer NOT NULL DEFAULT 30 CHECK (clock_in_early_minutes >= 0),
  no_show_grace_minutes   integer NOT NULL DEFAULT 15 CHECK (no_show_grace_minutes > 0),
  visitor_retention_days  integer NOT NULL DEFAULT 90 CHECK (visitor_retention_days > 0),
  personal_relief_minor   bigint NOT NULL DEFAULT 0 CHECK (personal_relief_minor >= 0)
);

-- pay rate per grade (configuration rows; no rate lives in code)
CREATE TABLE sec_pay_rates (
  org_id         text NOT NULL REFERENCES organisations(id),
  grade          text NOT NULL,
  hourly_minor   bigint NOT NULL CHECK (hourly_minor > 0),
  overtime_bp    integer NOT NULL CHECK (overtime_bp >= 10000),
  holiday_bp     integer NOT NULL CHECK (holiday_bp >= 10000),
  PRIMARY KEY (org_id, grade)
);

-- statutory deductions (employee) and contributions (employer), e.g. pension fund, health insurance, housing levy
CREATE TABLE sec_statutory_rules (
  org_id                text NOT NULL REFERENCES organisations(id),
  code                  text NOT NULL,
  party                 text NOT NULL CHECK (party IN ('employee', 'employer')),
  label                 text NOT NULL,
  rate_bp               integer NOT NULL CHECK (rate_bp BETWEEN 0 AND 10000),
  min_minor             bigint NOT NULL DEFAULT 0 CHECK (min_minor >= 0),
  base_cap_minor        bigint CHECK (base_cap_minor > 0),
  reduces_taxable_pay   boolean NOT NULL DEFAULT false,
  seq                   integer NOT NULL,
  PRIMARY KEY (org_id, code, party)
);

CREATE TABLE sec_income_tax_bands (
  org_id       text NOT NULL REFERENCES organisations(id),
  seq          integer NOT NULL,
  width_minor  bigint CHECK (width_minor > 0),     -- null: everything above
  rate_bp      integer NOT NULL CHECK (rate_bp BETWEEN 0 AND 10000),
  PRIMARY KEY (org_id, seq)
);

-- ---------------------------------------------------------------- clients, sites, posts, contracts
CREATE TABLE sec_clients (
  id                   text PRIMARY KEY,
  org_id               text NOT NULL REFERENCES organisations(id),
  number               text NOT NULL,
  name                 text NOT NULL,
  contact_name         text NOT NULL,
  email                text,
  phone                text,
  payment_terms_days   integer NOT NULL CHECK (payment_terms_days >= 0),
  wht_bp               integer NOT NULL CHECK (wht_bp BETWEEN 0 AND 10000),
  vat_wht_bp           integer NOT NULL CHECK (vat_wht_bp BETWEEN 0 AND 10000),
  credit_limit_minor   bigint NOT NULL CHECK (credit_limit_minor >= 0),
  created_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, number)
);
CREATE UNIQUE INDEX sec_clients_name ON sec_clients (org_id, lower(name));

-- members (role security_client) who see a client in the portal
CREATE TABLE sec_client_users (
  client_id  text NOT NULL REFERENCES sec_clients(id),
  org_id     text NOT NULL,
  user_id    text NOT NULL REFERENCES users(id),
  PRIMARY KEY (client_id, user_id)
);
CREATE INDEX sec_client_users_user ON sec_client_users (org_id, user_id);

CREATE TABLE sec_sites (
  id                 text PRIMARY KEY,
  org_id             text NOT NULL REFERENCES organisations(id),
  client_id          text REFERENCES sec_clients(id),              -- null: in-house estate site
  name               text NOT NULL,
  area               text NOT NULL DEFAULT '',
  kind               text NOT NULL,
  risk               text NOT NULL CHECK (risk IN ('low', 'medium', 'high')),
  lat                double precision,
  lng                double precision,
  radius_m           integer CHECK (radius_m > 0),
  instructions       text NOT NULL DEFAULT '',
  alarm_provider     text,
  alarm_account_ref  text,
  active             boolean NOT NULL DEFAULT true,
  created_at         timestamptz NOT NULL DEFAULT now(),
  CHECK ((lat IS NULL) = (lng IS NULL) AND (lat IS NULL) = (radius_m IS NULL)),
  CHECK ((alarm_provider IS NULL) = (alarm_account_ref IS NULL))
);
CREATE UNIQUE INDEX sec_sites_name ON sec_sites (org_id, lower(name));
-- an alarm-monitoring account belongs to one site
CREATE UNIQUE INDEX sec_sites_alarm_account ON sec_sites (alarm_provider, alarm_account_ref) WHERE alarm_provider IS NOT NULL;

CREATE TABLE sec_posts (
  id                 text PRIMARY KEY,
  org_id             text NOT NULL,
  site_id            text NOT NULL REFERENCES sec_sites(id),
  name               text NOT NULL,
  cover              text NOT NULL CHECK (cover IN ('24h', 'day', 'night')),
  guards_required    integer NOT NULL CHECK (guards_required > 0),
  order_version      integer NOT NULL DEFAULT 0 CHECK (order_version >= 0),
  order_text         text NOT NULL DEFAULT '',
  order_updated_at   timestamptz
);
CREATE UNIQUE INDEX sec_posts_name ON sec_posts (site_id, lower(name));

CREATE TABLE sec_contracts (
  id                     text PRIMARY KEY,
  org_id                 text NOT NULL,
  number                 text NOT NULL,
  client_id              text NOT NULL REFERENCES sec_clients(id),
  site_id                text NOT NULL REFERENCES sec_sites(id),
  start_date             date NOT NULL,
  end_date               date,
  monthly_fee_minor      bigint NOT NULL CHECK (monthly_fee_minor > 0),
  extra_hour_rate_minor  bigint NOT NULL CHECK (extra_hour_rate_minor >= 0),
  vat_bp                 integer NOT NULL CHECK (vat_bp BETWEEN 0 AND 10000),
  patrol_target_bp       integer NOT NULL CHECK (patrol_target_bp BETWEEN 0 AND 10000),
  response_minutes       integer NOT NULL CHECK (response_minutes > 0),
  status                 text NOT NULL CHECK (status IN ('active', 'ended')),
  created_by             text NOT NULL,
  UNIQUE (org_id, number),
  CHECK (end_date IS NULL OR end_date >= start_date)
);
CREATE UNIQUE INDEX sec_contracts_one_active ON sec_contracts (site_id) WHERE status = 'active';

-- ---------------------------------------------------------------- sales pipeline
CREATE TABLE sec_opportunities (
  id                    text PRIMARY KEY,
  org_id                text NOT NULL REFERENCES organisations(id),
  name                  text NOT NULL,
  stage                 text NOT NULL CHECK (stage IN ('enquiry', 'survey', 'quoted', 'won', 'lost')),
  guards_per_shift      integer NOT NULL CHECK (guards_per_shift > 0),
  grade                 text,
  monthly_quote_minor   bigint CHECK (monthly_quote_minor > 0),
  survey_date           date,
  client_id             text REFERENCES sec_clients(id),
  note                  text NOT NULL DEFAULT '',
  created_by            text NOT NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  CHECK (stage NOT IN ('quoted', 'won') OR monthly_quote_minor IS NOT NULL),
  CHECK (stage <> 'won' OR client_id IS NOT NULL)
);

-- ---------------------------------------------------------------- guards, training, equipment
CREATE TABLE sec_guards (
  id               text PRIMARY KEY,
  org_id           text NOT NULL REFERENCES organisations(id),
  number           text NOT NULL,
  name             text NOT NULL,
  grade            text NOT NULL,
  user_id          text REFERENCES users(id),
  phone            text,
  status           text NOT NULL CHECK (status IN ('active', 'leave', 'suspended', 'left')),
  licence_no       text NOT NULL,
  licence_expiry   date NOT NULL,
  vetting          text NOT NULL CHECK (vetting IN ('cleared', 'due', 'pending', 'failed')),
  home_site_id     text REFERENCES sec_sites(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, number)
);
CREATE UNIQUE INDEX sec_guards_user ON sec_guards (org_id, user_id) WHERE user_id IS NOT NULL;

CREATE TABLE sec_guard_training (
  id        text PRIMARY KEY,
  org_id    text NOT NULL,
  guard_id  text NOT NULL REFERENCES sec_guards(id),
  course    text NOT NULL,
  valid_to  date NOT NULL
);

CREATE TABLE sec_post_order_acks (
  post_id   text NOT NULL REFERENCES sec_posts(id),
  version   integer NOT NULL,
  guard_id  text NOT NULL REFERENCES sec_guards(id),
  org_id    text NOT NULL,
  acked_by  text NOT NULL,
  acked_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (post_id, version, guard_id)
);

CREATE TABLE sec_equipment (
  id           text PRIMARY KEY,
  org_id       text NOT NULL REFERENCES organisations(id),
  code         text NOT NULL,
  kind         text NOT NULL,
  description  text NOT NULL DEFAULT '',
  status       text NOT NULL CHECK (status IN ('in_store', 'issued', 'lost', 'retired')),
  UNIQUE (org_id, code)
);

CREATE TABLE sec_equipment_issues (
  id                text PRIMARY KEY,
  org_id            text NOT NULL,
  equipment_id      text NOT NULL REFERENCES sec_equipment(id),
  guard_id          text NOT NULL REFERENCES sec_guards(id),
  issued_at         timestamptz NOT NULL DEFAULT now(),
  issued_by         text NOT NULL,
  returned_at       timestamptz,
  returned_by       text,
  return_condition  text CHECK (return_condition IN ('good', 'damaged', 'lost')),
  note              text NOT NULL DEFAULT ''
);
-- an item is held by one guard at a time
CREATE UNIQUE INDEX sec_equipment_one_holder ON sec_equipment_issues (equipment_id) WHERE returned_at IS NULL;

-- ---------------------------------------------------------------- shifts, attendance and timesheets
CREATE TABLE sec_shifts (
  id                  text PRIMARY KEY,
  org_id              text NOT NULL REFERENCES organisations(id),
  site_id             text NOT NULL REFERENCES sec_sites(id),
  post_id             text NOT NULL REFERENCES sec_posts(id),
  guard_id            text REFERENCES sec_guards(id),
  starts_at           timestamptz NOT NULL,
  ends_at             timestamptz NOT NULL,
  extra               boolean NOT NULL DEFAULT false,      -- client-requested extra cover, billed per hour
  holiday             boolean NOT NULL DEFAULT false,
  status              text NOT NULL CHECK (status IN ('open', 'assigned', 'cancelled')),
  offered             boolean NOT NULL DEFAULT false,
  published_at        timestamptz,
  created_by          text NOT NULL,
  -- attendance evidence, recorded as submitted (jsonb: capturedAt, receivedAt, method, lat, lng, accuracyM, …)
  clock_in            jsonb,
  clock_out           jsonb,
  clocked_in_by       text,
  clocked_out_by      text,
  no_show             boolean NOT NULL DEFAULT false,
  -- a correction of the worked times (the evidence above is kept)
  adjusted_in_at      timestamptz,
  adjusted_out_at     timestamptz,
  adjust_reason       text,
  adjusted_by         text,
  timesheet_status    text NOT NULL DEFAULT 'none' CHECK (timesheet_status IN ('none', 'submitted', 'approved')),
  normal_minutes      integer NOT NULL DEFAULT 0 CHECK (normal_minutes >= 0),
  overtime_minutes    integer NOT NULL DEFAULT 0 CHECK (overtime_minutes >= 0),
  approved_by         text,
  approved_at         timestamptz,
  billed_invoice_id   text,
  payroll_run_id      text,
  CHECK (ends_at > starts_at),
  CHECK (status <> 'assigned' OR guard_id IS NOT NULL),
  CHECK (status <> 'open' OR guard_id IS NULL),
  CHECK ((timesheet_status = 'approved') = (approved_by IS NOT NULL)),
  -- separation of duties: whoever recorded or corrected the attendance cannot approve it
  CONSTRAINT sec_timesheet_second_person CHECK (
    approved_by IS NULL OR (approved_by IS DISTINCT FROM adjusted_by AND approved_by IS DISTINCT FROM clocked_in_by
      AND approved_by IS DISTINCT FROM clocked_out_by)),
  -- a guard is never on two shifts at once
  CONSTRAINT sec_guard_not_double_booked EXCLUDE USING gist (guard_id WITH =, tstzrange(starts_at, ends_at) WITH &&)
    WHERE (guard_id IS NOT NULL AND status <> 'cancelled')
);
CREATE INDEX sec_shifts_time ON sec_shifts (org_id, starts_at);
CREATE INDEX sec_shifts_timesheet ON sec_shifts (org_id, timesheet_status);

-- ---------------------------------------------------------------- patrols and checkpoints
CREATE TABLE sec_checkpoints (
  id              text PRIMARY KEY,
  org_id          text NOT NULL,
  site_id         text NOT NULL REFERENCES sec_sites(id),
  code            text NOT NULL,
  name            text NOT NULL,
  tag_ref         text NOT NULL,
  seq             integer NOT NULL,
  offset_minutes  integer NOT NULL CHECK (offset_minutes >= 0),
  grace_minutes   integer NOT NULL CHECK (grace_minutes >= 0),
  UNIQUE (site_id, code),
  UNIQUE (site_id, tag_ref)
);

CREATE TABLE sec_patrols (
  id          text PRIMARY KEY,
  org_id      text NOT NULL,
  site_id     text NOT NULL REFERENCES sec_sites(id),
  guard_id    text NOT NULL REFERENCES sec_guards(id),
  shift_id    text REFERENCES sec_shifts(id),
  started_at  timestamptz NOT NULL,
  closed_at   timestamptz,
  started_by  text NOT NULL,
  CHECK (closed_at IS NULL OR closed_at >= started_at)
);
CREATE INDEX sec_patrols_time ON sec_patrols (org_id, started_at);

CREATE TABLE sec_patrol_scans (
  id             text PRIMARY KEY,
  org_id         text NOT NULL,
  patrol_id      text NOT NULL REFERENCES sec_patrols(id),
  checkpoint_id  text NOT NULL REFERENCES sec_checkpoints(id),
  scanned_at     timestamptz NOT NULL,
  received_at    timestamptz NOT NULL DEFAULT now(),
  method         text NOT NULL CHECK (method IN ('nfc', 'qr', 'manual')),
  lat            double precision,
  lng            double precision,
  note           text NOT NULL DEFAULT '',
  recorded_by    text NOT NULL,
  UNIQUE (patrol_id, checkpoint_id)
);

-- ---------------------------------------------------------------- alarms
CREATE TABLE sec_alarms (
  id               text PRIMARY KEY,
  org_id           text NOT NULL REFERENCES organisations(id),
  number           text NOT NULL,
  site_id          text NOT NULL REFERENCES sec_sites(id),
  source           text NOT NULL CHECK (source IN ('panic', 'device', 'missed_checkpoint', 'no_show', 'manual')),
  provider         text,
  source_ref       text,
  guard_id         text REFERENCES sec_guards(id),
  raised_at        timestamptz NOT NULL,
  received_at      timestamptz NOT NULL DEFAULT now(),
  detail           text NOT NULL,
  status           text NOT NULL CHECK (status IN ('raised', 'acknowledged', 'dispatched', 'resolved')),
  acknowledged_at  timestamptz,
  acknowledged_by  text,
  dispatch_unit    text,
  dispatched_at    timestamptz,
  dispatched_by    text,
  resolved_at      timestamptz,
  resolved_by      text,
  outcome          text CHECK (outcome IN ('genuine', 'false_alarm')),
  resolution_note  text,
  incident_id      text,
  UNIQUE (org_id, number),
  CHECK (status = 'raised' OR acknowledged_at IS NOT NULL),
  CHECK ((status = 'resolved') = (resolved_at IS NOT NULL))
);
-- one alarm per provider event, per missed checkpoint and per no-show
CREATE UNIQUE INDEX sec_alarms_source ON sec_alarms (org_id, source, coalesce(provider, ''), source_ref)
  WHERE source_ref IS NOT NULL;

-- ---------------------------------------------------------------- incidents and the occurrence book
CREATE TABLE sec_incidents (
  id                  text PRIMARY KEY,
  org_id              text NOT NULL REFERENCES organisations(id),
  number              text NOT NULL,
  site_id             text NOT NULL REFERENCES sec_sites(id),
  type                text NOT NULL,
  severity            text NOT NULL CHECK (severity IN ('low', 'medium', 'high')),
  description         text NOT NULL,
  occurred_at         timestamptz NOT NULL,
  reported_by         text NOT NULL,
  reported_at         timestamptz NOT NULL DEFAULT now(),
  guard_id            text REFERENCES sec_guards(id),
  alarm_id            text REFERENCES sec_alarms(id),
  status              text NOT NULL CHECK (status IN ('open', 'investigating', 'closed')),
  investigator_user   text,
  closed_by           text,
  closed_at           timestamptz,
  closing_note        text,
  UNIQUE (org_id, number),
  CHECK ((status = 'closed') = (closed_by IS NOT NULL)),
  -- separation of duties: the reporter does not close their own incident
  CONSTRAINT sec_incident_closed_by_other CHECK (closed_by IS NULL OR closed_by <> reported_by)
);
CREATE INDEX sec_incidents_site ON sec_incidents (org_id, site_id, occurred_at);

-- the facts of an incident are kept as reported; only its handling (status, investigator, closure) moves on
CREATE FUNCTION sec_incident_facts_are_fixed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Incidents are never deleted' USING ERRCODE = 'PA003';
  END IF;
  IF NEW.number IS DISTINCT FROM OLD.number OR NEW.org_id IS DISTINCT FROM OLD.org_id
     OR NEW.site_id IS DISTINCT FROM OLD.site_id OR NEW.type IS DISTINCT FROM OLD.type
     OR NEW.severity IS DISTINCT FROM OLD.severity OR NEW.description IS DISTINCT FROM OLD.description
     OR NEW.occurred_at IS DISTINCT FROM OLD.occurred_at OR NEW.reported_by IS DISTINCT FROM OLD.reported_by
     OR NEW.reported_at IS DISTINCT FROM OLD.reported_at OR NEW.guard_id IS DISTINCT FROM OLD.guard_id
     OR NEW.alarm_id IS DISTINCT FROM OLD.alarm_id THEN
    RAISE EXCEPTION 'An incident''s facts cannot be changed: add a correction to the occurrence book' USING ERRCODE = 'PA003';
  END IF;
  IF OLD.status = 'closed' THEN
    RAISE EXCEPTION 'A closed incident cannot be changed' USING ERRCODE = 'PA003';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER sec_incidents_fixed BEFORE UPDATE OR DELETE ON sec_incidents
  FOR EACH ROW EXECUTE FUNCTION sec_incident_facts_are_fixed();

CREATE TABLE sec_occurrences (
  id           text PRIMARY KEY,
  org_id       text NOT NULL REFERENCES organisations(id),
  number       text NOT NULL,
  site_id      text NOT NULL REFERENCES sec_sites(id),
  incident_id  text REFERENCES sec_incidents(id),
  alarm_id     text REFERENCES sec_alarms(id),
  at           timestamptz NOT NULL,
  recorded_at  timestamptz NOT NULL DEFAULT now(),
  recorded_by  text,                                       -- null: the system (e.g. an alarm received)
  kind         text NOT NULL CHECK (kind IN ('entry', 'incident', 'status', 'correction', 'alarm', 'handover',
                                             'patrol', 'visitor')),
  text         text NOT NULL,
  corrects_id  text REFERENCES sec_occurrences(id),
  attachments  jsonb NOT NULL DEFAULT '[]',
  UNIQUE (org_id, number),
  CHECK ((kind = 'correction') = (corrects_id IS NOT NULL))
);
CREATE INDEX sec_occurrences_site ON sec_occurrences (org_id, site_id, at);

CREATE FUNCTION sec_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: add a new entry instead', TG_TABLE_NAME USING ERRCODE = 'PA003';
END $$;
CREATE TRIGGER sec_occurrences_append_only BEFORE UPDATE OR DELETE ON sec_occurrences
  FOR EACH ROW EXECUTE FUNCTION sec_append_only();
CREATE TRIGGER sec_occurrences_no_truncate BEFORE TRUNCATE ON sec_occurrences
  FOR EACH STATEMENT EXECUTE FUNCTION sec_append_only();

-- ---------------------------------------------------------------- visitors and watchlist
CREATE TABLE sec_visitors (
  id                 text PRIMARY KEY,
  org_id             text NOT NULL REFERENCES organisations(id),
  number             text NOT NULL,
  site_id            text NOT NULL REFERENCES sec_sites(id),
  name               text NOT NULL,
  host               text NOT NULL,
  purpose            text NOT NULL,
  kind               text NOT NULL CHECK (kind IN ('pre_registered', 'walk_in')),
  expected_date      date NOT NULL,
  expected_time      text,
  pass_code          text,
  plate              text,
  id_type            text,
  id_last4           text CHECK (id_last4 IS NULL OR length(id_last4) = 4),
  status             text NOT NULL CHECK (status IN ('expected', 'awaiting_host', 'approved', 'on_site', 'departed', 'denied')),
  host_approval_by   text,
  checked_in_at      timestamptz,
  checked_in_by      text,
  checked_out_at     timestamptz,
  checked_out_by     text,
  denied_reason      text,
  denied_by          text,
  retain_until       date NOT NULL,
  purged_at          timestamptz,
  created_by         text NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, number)
);
CREATE INDEX sec_visitors_site ON sec_visitors (org_id, site_id, status);

CREATE TABLE sec_watchlist (
  id              text PRIMARY KEY,
  org_id          text NOT NULL REFERENCES organisations(id),
  site_id         text REFERENCES sec_sites(id),             -- null: every site
  kind            text NOT NULL CHECK (kind IN ('person', 'vehicle')),
  value           text NOT NULL,
  match_key       text NOT NULL,                             -- lower-case name / plate without spaces
  reason          text NOT NULL,
  added_by        text NOT NULL,
  added_at        timestamptz NOT NULL DEFAULT now(),
  removed_by      text,
  removed_at      timestamptz,
  removed_reason  text
);
CREATE INDEX sec_watchlist_match ON sec_watchlist (org_id, kind, match_key) WHERE removed_at IS NULL;

CREATE TABLE sec_watchlist_hits (
  id            text PRIMARY KEY,
  org_id        text NOT NULL,
  watchlist_id  text NOT NULL REFERENCES sec_watchlist(id),
  site_id       text NOT NULL REFERENCES sec_sites(id),
  at            timestamptz NOT NULL DEFAULT now(),
  by_user       text NOT NULL,
  presented     text NOT NULL
);

-- ---------------------------------------------------------------- physical access control
CREATE TABLE sec_doors (
  id       text PRIMARY KEY,
  org_id   text NOT NULL REFERENCES organisations(id),
  site_id  text NOT NULL REFERENCES sec_sites(id),
  code     text NOT NULL,
  name     text NOT NULL,
  zone     text NOT NULL,
  UNIQUE (org_id, code)
);

CREATE TABLE sec_access_groups (
  id         text PRIMARY KEY,
  org_id     text NOT NULL REFERENCES organisations(id),
  name       text NOT NULL,
  door_ids   text[] NOT NULL CHECK (cardinality(door_ids) > 0),
  from_time  text NOT NULL,
  to_time    text NOT NULL
);
CREATE UNIQUE INDEX sec_access_groups_name ON sec_access_groups (org_id, lower(name));

CREATE TABLE sec_credentials (
  id             text PRIMARY KEY,
  org_id         text NOT NULL REFERENCES organisations(id),
  number         text NOT NULL,
  guard_id       text REFERENCES sec_guards(id),
  holder_name    text NOT NULL,
  holder_key     text NOT NULL,                              -- guard id, or the lower-case name of other staff
  kind           text NOT NULL CHECK (kind IN ('card', 'fob', 'mobile', 'pin')),
  group_ids      text[] NOT NULL CHECK (cardinality(group_ids) > 0),
  valid_from     date NOT NULL,
  valid_to       date NOT NULL,
  status         text NOT NULL CHECK (status IN ('active', 'suspended', 'revoked')),
  status_reason  text,
  replaced_by    text,
  created_by     text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, number),
  CHECK (valid_to >= valid_from)
);
-- one active credential of each kind per person
CREATE UNIQUE INDEX sec_credentials_one_active ON sec_credentials (org_id, holder_key, kind) WHERE status = 'active';

CREATE TABLE sec_access_decisions (
  id             text PRIMARY KEY,
  org_id         text NOT NULL,
  credential_id  text NOT NULL REFERENCES sec_credentials(id),
  door_id        text NOT NULL REFERENCES sec_doors(id),
  at             timestamptz NOT NULL,
  allowed        boolean NOT NULL,
  reason         text NOT NULL,
  checked_by     text NOT NULL,
  checked_at     timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER sec_access_decisions_append_only BEFORE UPDATE OR DELETE ON sec_access_decisions
  FOR EACH ROW EXECUTE FUNCTION sec_append_only();

-- ---------------------------------------------------------------- client billing
CREATE TABLE sec_invoices (
  id                         text PRIMARY KEY,
  org_id                     text NOT NULL REFERENCES organisations(id),
  number                     text NOT NULL,
  client_id                  text NOT NULL REFERENCES sec_clients(id),
  site_id                    text REFERENCES sec_sites(id),
  contract_id                text REFERENCES sec_contracts(id),
  period                     text,
  date                       date NOT NULL,
  due_date                   date NOT NULL,
  net_minor                  bigint NOT NULL CHECK (net_minor > 0),
  vat_minor                  bigint NOT NULL CHECK (vat_minor >= 0),
  total_minor                bigint NOT NULL,
  wht_expected_minor         bigint NOT NULL CHECK (wht_expected_minor >= 0),
  vat_wht_expected_minor     bigint NOT NULL CHECK (vat_wht_expected_minor >= 0),
  run_key                    text,                           -- unique per billing run item (contract × month, late fee × day)
  journal_id                 text NOT NULL,
  created_by                 text NOT NULL,
  created_at                 timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, number),
  UNIQUE (org_id, run_key),
  CHECK (total_minor = net_minor + vat_minor),
  CHECK (due_date >= date)
);
CREATE INDEX sec_invoices_client ON sec_invoices (org_id, client_id, date);

CREATE TABLE sec_invoice_lines (
  id            text PRIMARY KEY,
  org_id        text NOT NULL,
  invoice_id    text NOT NULL REFERENCES sec_invoices(id),
  seq           integer NOT NULL,
  kind          text NOT NULL CHECK (kind IN ('contract', 'extra_hours', 'late_fee', 'other')),
  description   text NOT NULL,
  quantity      integer NOT NULL CHECK (quantity > 0),
  unit          text NOT NULL,
  amount_minor  bigint NOT NULL CHECK (amount_minor > 0),
  UNIQUE (invoice_id, seq)
);

ALTER TABLE sec_shifts ADD CONSTRAINT sec_shifts_billed FOREIGN KEY (billed_invoice_id) REFERENCES sec_invoices(id);

CREATE TABLE sec_receipts (
  id            text PRIMARY KEY,
  org_id        text NOT NULL REFERENCES organisations(id),
  number        text NOT NULL,
  client_id     text NOT NULL REFERENCES sec_clients(id),
  date          date NOT NULL,
  amount_minor  bigint NOT NULL CHECK (amount_minor > 0),
  method        text NOT NULL CHECK (method IN ('bank_transfer', 'mobile_money', 'cheque', 'card', 'cash')),
  reference     text NOT NULL,
  journal_id    text NOT NULL,
  recorded_by   text NOT NULL,
  recorded_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, number)
);
-- the same payment reference is recorded once per client
CREATE UNIQUE INDEX sec_receipts_reference ON sec_receipts (org_id, client_id, lower(reference));

CREATE TABLE sec_receipt_allocations (
  receipt_id    text NOT NULL REFERENCES sec_receipts(id),
  invoice_id    text NOT NULL REFERENCES sec_invoices(id),
  org_id        text NOT NULL,
  amount_minor  bigint NOT NULL CHECK (amount_minor > 0),
  PRIMARY KEY (receipt_id, invoice_id)
);

CREATE TABLE sec_tax_certificates (
  id               text PRIMARY KEY,
  org_id           text NOT NULL,
  number           text NOT NULL,
  client_id        text NOT NULL REFERENCES sec_clients(id),
  invoice_id       text NOT NULL REFERENCES sec_invoices(id),
  kind             text NOT NULL CHECK (kind IN ('income_tax', 'vat')),
  certificate_ref  text NOT NULL,
  date             date NOT NULL,
  amount_minor     bigint NOT NULL CHECK (amount_minor > 0),
  journal_id       text NOT NULL,
  recorded_by      text NOT NULL,
  UNIQUE (invoice_id, kind),
  UNIQUE (org_id, number)
);

CREATE TABLE sec_client_notes (
  id            text PRIMARY KEY,
  org_id        text NOT NULL,
  client_id     text NOT NULL REFERENCES sec_clients(id),
  at            timestamptz NOT NULL DEFAULT now(),
  kind          text NOT NULL CHECK (kind IN ('call', 'email', 'note', 'promise', 'reminder')),
  text          text NOT NULL,
  promise_date  date,
  by_user       text NOT NULL,
  delivery      text
);

CREATE TABLE sec_bank_lines (
  id                    text PRIMARY KEY,
  org_id                text NOT NULL REFERENCES organisations(id),
  date                  date NOT NULL,
  description           text NOT NULL,
  reference             text NOT NULL,
  amount_minor          bigint NOT NULL CHECK (amount_minor <> 0),
  status                text NOT NULL CHECK (status IN ('unmatched', 'suggested', 'matched', 'ignored')),
  suggested_invoice_id  text REFERENCES sec_invoices(id),
  receipt_id            text REFERENCES sec_receipts(id),
  imported_by           text NOT NULL,
  imported_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, date, reference, amount_minor),
  CHECK ((status = 'matched') = (receipt_id IS NOT NULL))
);

-- ---------------------------------------------------------------- payroll and costs
CREATE TABLE sec_payroll_runs (
  id                        text PRIMARY KEY,
  org_id                    text NOT NULL REFERENCES organisations(id),
  number                    text NOT NULL,
  period                    text NOT NULL,
  status                    text NOT NULL CHECK (status IN ('prepared', 'approved', 'paid')),
  prepared_by               text NOT NULL,
  prepared_at               timestamptz NOT NULL DEFAULT now(),
  approved_by               text,
  approved_at               timestamptz,
  gross_minor               bigint NOT NULL,
  employee_deductions_minor bigint NOT NULL,
  income_tax_minor          bigint NOT NULL,
  employer_minor            bigint NOT NULL,
  net_minor                 bigint NOT NULL,
  journal_id                text,
  paid_on                   date,
  paid_reference            text,
  paid_journal_id           text,
  UNIQUE (org_id, period),
  UNIQUE (org_id, number),
  CHECK (net_minor = gross_minor - employee_deductions_minor - income_tax_minor),
  CHECK (status = 'prepared' OR approved_by IS NOT NULL),
  -- separation of duties: the preparer does not approve
  CONSTRAINT sec_payroll_second_person CHECK (approved_by IS NULL OR approved_by <> prepared_by)
);
ALTER TABLE sec_shifts ADD CONSTRAINT sec_shifts_payroll FOREIGN KEY (payroll_run_id) REFERENCES sec_payroll_runs(id);

CREATE TABLE sec_payroll_lines (
  run_id            text NOT NULL REFERENCES sec_payroll_runs(id),
  org_id            text NOT NULL,
  guard_id          text NOT NULL REFERENCES sec_guards(id),
  grade             text NOT NULL,
  normal_minutes    integer NOT NULL,
  overtime_minutes  integer NOT NULL,
  holiday_minutes   integer NOT NULL,
  gross_minor       bigint NOT NULL,
  deductions        jsonb NOT NULL,
  income_tax_minor  bigint NOT NULL,
  employer          jsonb NOT NULL,
  net_minor         bigint NOT NULL,
  PRIMARY KEY (run_id, guard_id)
);

-- wages and employer contributions per site (sums to the payroll journal's wage and contribution lines)
CREATE TABLE sec_payroll_site_costs (
  run_id          text NOT NULL REFERENCES sec_payroll_runs(id),
  org_id          text NOT NULL,
  site_id         text NOT NULL REFERENCES sec_sites(id),
  gross_minor     bigint NOT NULL,
  employer_minor  bigint NOT NULL,
  PRIMARY KEY (run_id, site_id)
);

CREATE TABLE sec_costs (
  id            text PRIMARY KEY,
  org_id        text NOT NULL REFERENCES organisations(id),
  number        text NOT NULL,
  site_id       text REFERENCES sec_sites(id),
  account       text NOT NULL,
  date          date NOT NULL,
  description   text NOT NULL,
  amount_minor  bigint NOT NULL CHECK (amount_minor > 0),
  paid_from     text NOT NULL CHECK (paid_from IN ('bank', 'payable')),
  journal_id    text NOT NULL,
  recorded_by   text NOT NULL,
  UNIQUE (org_id, number)
);

CREATE TABLE sec_remittances (
  id            text PRIMARY KEY,
  org_id        text NOT NULL REFERENCES organisations(id),
  number        text NOT NULL,
  account       text NOT NULL CHECK (account IN ('2810', '2820')),
  date          date NOT NULL,
  amount_minor  bigint NOT NULL CHECK (amount_minor > 0),
  reference     text NOT NULL,
  journal_id    text NOT NULL,
  recorded_by   text NOT NULL,
  UNIQUE (org_id, number)
);

-- which security record a ledger journal belongs to (reports read the ledger through these links)
CREATE TABLE sec_ledger_links (
  journal_id  text PRIMARY KEY REFERENCES journal_entries(id),
  org_id      text NOT NULL,
  kind        text NOT NULL CHECK (kind IN ('invoice', 'receipt', 'certificate', 'payroll', 'payroll_payment',
                                            'cost', 'remittance')),
  site_id     text REFERENCES sec_sites(id),
  client_id   text REFERENCES sec_clients(id),
  date        date NOT NULL
);
CREATE INDEX sec_ledger_links_org ON sec_ledger_links (org_id, date);

-- ---------------------------------------------------------------- messages to guards (recorded, never sent)
CREATE TABLE sec_messages (
  id          text PRIMARY KEY,
  org_id      text NOT NULL REFERENCES organisations(id),
  guard_id    text NOT NULL REFERENCES sec_guards(id),
  text        text NOT NULL,
  status      text NOT NULL,
  sent_by     text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
