-- Property Management, complete: everything the workspace's screens need on the server that the earlier migrations did
-- not have. Additive only: new tables, new nullable columns, and wider CHECK lists (every existing row stays valid).
--
--   tenants      a tenant's profile (emergency contact, guarantor, employment, household) — people stay in contacts
--   work         tasks and follow-ups, obligations (licences, renewals, inspections due), time clock
--   marketing    segments (saved contact filters), campaigns (recorded per contact, never sent from here), listings
--   collections  promises to pay, payment reminders (recorded through the outbox), credit refunds with approval,
--                supplier payment runs, transfers between the organisation's bank accounts
--   funds        service-charge funds: budget, apportionment per unit, billing per period, expenses charged to the fund
--   staff        building staff, rosters, payroll deductions (country-neutral rules), payroll runs
--   assets       fixed assets with monthly depreciation, loans, maintenance stock, renovations, insurance and claims,
--                building service schedules and incidents
--   recurring    recurring supplier bills and recurring journals (generated when due, never twice for one month)
--   stays        short stays in units let by the night: bookings, check-in / check-out, housekeeping, payments
--   ledger       budgets per account and month, tax codes, VAT returns, exchange rates (core finance, every product)
--
-- Money is integer minor units; every money movement posts to the organisation's ONE ledger (system:property or
-- system:tax journals), linked to its property / owner / tenant / fund in pm_ledger_links.

-- ============================================================== wider lists on existing tables
DO $$
DECLARE c record;
BEGIN
  FOR c IN SELECT conrelid::regclass AS tbl, conname FROM pg_constraint
    WHERE contype = 'c' AND (
      (conrelid = 'pm_invoice_lines'::regclass AND pg_get_constraintdef(oid) LIKE '%payee%') OR
      (conrelid = 'pm_bills'::regclass AND pg_get_constraintdef(oid) LIKE '%recover_from%') OR
      (conrelid = 'pm_ledger_links'::regclass AND pg_get_constraintdef(oid) LIKE '%kind%'))
  LOOP
    EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', c.tbl, c.conname);
  END LOOP;
END $$;

-- invoice lines may be billed for a service-charge fund (Cr 2180 when issued, Dr 2180 / Cr 2350 when collected)
ALTER TABLE pm_invoice_lines ADD COLUMN fund_id text;
ALTER TABLE pm_invoice_lines ADD CONSTRAINT pm_invoice_lines_payee_check
  CHECK (payee IN ('owner', 'agency', 'deposit', 'fund'));
ALTER TABLE pm_invoice_lines ADD CONSTRAINT pm_invoice_lines_fund_check CHECK ((payee = 'fund') = (fund_id IS NOT NULL));

-- a bill may be charged to a service-charge fund; a company bill may name its expense account and its input VAT;
-- a bill may belong to a renovation
ALTER TABLE pm_bills ADD COLUMN fund_id text;
ALTER TABLE pm_bills ADD COLUMN expense_account text;
ALTER TABLE pm_bills ADD COLUMN vat_minor bigint NOT NULL DEFAULT 0 CHECK (vat_minor >= 0);
ALTER TABLE pm_bills ADD COLUMN renovation_id text;
ALTER TABLE pm_bills ADD COLUMN payment_run_id text;
ALTER TABLE pm_bills ADD COLUMN recurring_id text;
ALTER TABLE pm_bills ADD CONSTRAINT pm_bills_recover_from_check CHECK (recover_from IN ('owner', 'company', 'fund'));
ALTER TABLE pm_bills ADD CONSTRAINT pm_bills_recover_target_check
  CHECK (recover_from = 'company' OR (recover_from = 'fund' AND fund_id IS NOT NULL)
         OR (recover_from = 'owner' AND (owner_id IS NOT NULL OR mig_job_id IS NOT NULL)));
ALTER TABLE pm_bills ADD CONSTRAINT pm_bills_vat_within CHECK (vat_minor < amount_minor);

ALTER TABLE pm_ledger_links ADD COLUMN fund_id text;
ALTER TABLE pm_ledger_links ADD CONSTRAINT pm_ledger_links_kind_check CHECK (kind IN ('invoice', 'receipt',
  'collection', 'credit_note', 'deposit_refund', 'bill', 'bill_payment', 'payout', 'credit_refund', 'transfer',
  'payroll', 'payroll_payment', 'depreciation', 'loan', 'stay_payment', 'asset'));
CREATE INDEX pm_ledger_links_fund ON pm_ledger_links (fund_id) WHERE fund_id IS NOT NULL;
CREATE INDEX pm_ledger_links_property ON pm_ledger_links (property_id) WHERE property_id IS NOT NULL;

-- units let by the night, and their housekeeping state
ALTER TABLE pm_units ADD COLUMN short_stay boolean NOT NULL DEFAULT false;
ALTER TABLE pm_units ADD COLUMN nightly_rate_minor bigint CHECK (nightly_rate_minor > 0);
ALTER TABLE pm_units ADD COLUMN housekeeping text NOT NULL DEFAULT 'clean' CHECK (housekeeping IN ('clean', 'dirty', 'inspected'));

-- ============================================================== tenants
CREATE TABLE pm_tenant_profiles (
  tenant_id               text PRIMARY KEY REFERENCES contacts(id),
  org_id                  text NOT NULL REFERENCES organisations(id),
  emergency_contact_id    text REFERENCES contacts(id),
  emergency_relationship  text NOT NULL DEFAULT '',
  guarantor_contact_id    text REFERENCES contacts(id),
  employer                text NOT NULL DEFAULT '',
  occupation              text NOT NULL DEFAULT '',
  monthly_income_minor    bigint CHECK (monthly_income_minor >= 0),
  id_document             text NOT NULL DEFAULT '',
  date_of_birth           date,
  occupants               integer CHECK (occupants BETWEEN 0 AND 50),
  vehicles                text NOT NULL DEFAULT '',
  pets                    text NOT NULL DEFAULT '',
  preferred_channel       text NOT NULL DEFAULT 'phone' CHECK (preferred_channel IN ('phone', 'email', 'sms', 'whatsapp', 'inapp')),
  notes                   text NOT NULL DEFAULT '',
  updated_by              text REFERENCES users(id),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  CHECK (emergency_contact_id IS DISTINCT FROM tenant_id),
  CHECK (guarantor_contact_id IS DISTINCT FROM tenant_id)
);
COMMENT ON TABLE pm_tenant_profiles IS 'A tenant''s profile; the people (tenant, emergency contact, guarantor) are contacts.';

-- the emergency contact links the workspace kept as "emergency:<id>" / "emergrel:<relationship>" tags move here
INSERT INTO pm_tenant_profiles (tenant_id, org_id, emergency_contact_id, emergency_relationship)
SELECT c.id, c.org_id, e.id,
  COALESCE((SELECT substr(t, 10) FROM unnest(c.tags) t WHERE t LIKE 'emergrel:%' LIMIT 1), '')
FROM contacts c
JOIN contacts e ON e.org_id = c.org_id AND e.id = (SELECT substr(t, 11) FROM unnest(c.tags) t WHERE t LIKE 'emergency:%' LIMIT 1)
WHERE EXISTS (SELECT 1 FROM unnest(c.tags) t WHERE t LIKE 'emergency:%') AND e.id <> c.id
ON CONFLICT (tenant_id) DO NOTHING;
UPDATE contacts SET tags = ARRAY(SELECT t FROM unnest(tags) t WHERE t NOT LIKE 'emergency:%' AND t NOT LIKE 'emergrel:%')
WHERE EXISTS (SELECT 1 FROM unnest(tags) t WHERE t LIKE 'emergency:%' OR t LIKE 'emergrel:%');

-- ============================================================== work
CREATE TABLE pm_tasks (
  id           text PRIMARY KEY,
  org_id       text NOT NULL REFERENCES organisations(id),
  number       text NOT NULL,
  title        text NOT NULL,
  notes        text NOT NULL DEFAULT '',
  due_date     date,
  priority     text NOT NULL DEFAULT 'normal' CHECK (priority IN ('urgent', 'high', 'normal', 'low')),
  status       text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done', 'cancelled')),
  kind         text NOT NULL DEFAULT 'task' CHECK (kind IN ('task', 'follow_up', 'call', 'meeting', 'visit')),
  assignee_id  text REFERENCES users(id),
  contact_id   text REFERENCES contacts(id),
  property_id  text REFERENCES pm_properties(id),
  lead_id      text REFERENCES pm_leads(id),
  at_time      text CHECK (at_time ~ '^([01]\d|2[0-3]):[0-5]\d$'),
  created_by   text NOT NULL REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  done_by      text REFERENCES users(id),
  done_at      timestamptz,
  done_note    text,
  UNIQUE (org_id, number)
);
CREATE INDEX pm_tasks_open ON pm_tasks (org_id, due_date) WHERE status = 'open';

CREATE TABLE pm_obligations (
  id             text PRIMARY KEY,
  org_id         text NOT NULL REFERENCES organisations(id),
  title          text NOT NULL,
  kind           text NOT NULL CHECK (kind IN ('licence', 'insurance', 'inspection', 'tax', 'contract', 'safety', 'other')),
  property_id    text REFERENCES pm_properties(id),
  due_date       date NOT NULL,
  every_months   integer CHECK (every_months BETWEEN 1 AND 120),
  responsible    text NOT NULL DEFAULT '',
  notes          text NOT NULL DEFAULT '',
  status         text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done')),
  last_done_on   date,
  last_done_by   text REFERENCES users(id),
  created_by     text NOT NULL REFERENCES users(id),
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE pm_time_entries (
  id             text PRIMARY KEY,
  org_id         text NOT NULL REFERENCES organisations(id),
  user_id        text NOT NULL REFERENCES users(id),
  work_order_id  text REFERENCES pm_work_orders(id),
  clock_in       timestamptz NOT NULL,
  clock_out      timestamptz,
  note           text NOT NULL DEFAULT '',
  CHECK (clock_out IS NULL OR clock_out >= clock_in)
);
CREATE UNIQUE INDEX pm_time_entries_one_open ON pm_time_entries (user_id, org_id) WHERE clock_out IS NULL;

-- ============================================================== marketing
CREATE TABLE pm_segments (
  id          text PRIMARY KEY,
  org_id      text NOT NULL REFERENCES organisations(id),
  name        text NOT NULL,
  rules       jsonb NOT NULL,
  created_by  text NOT NULL REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, name)
);

CREATE TABLE pm_campaigns (
  id          text PRIMARY KEY,
  org_id      text NOT NULL REFERENCES organisations(id),
  number      text NOT NULL,
  name        text NOT NULL,
  segment_id  text NOT NULL REFERENCES pm_segments(id),
  channel     text NOT NULL CHECK (channel IN ('email', 'sms', 'whatsapp', 'inapp')),
  subject     text NOT NULL DEFAULT '',
  body        text NOT NULL,
  recipients  integer NOT NULL,
  recorded    integer NOT NULL,
  blocked     integer NOT NULL,
  created_by  text NOT NULL REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, number)
);

CREATE TABLE pm_listings (
  id                  text PRIMARY KEY,
  org_id              text NOT NULL REFERENCES organisations(id),
  number              text NOT NULL,
  unit_id             text NOT NULL REFERENCES pm_units(id),
  title               text NOT NULL,
  description         text NOT NULL DEFAULT '',
  asking_rent_minor   bigint NOT NULL CHECK (asking_rent_minor > 0),
  available_from      date NOT NULL,
  status              text NOT NULL CHECK (status IN ('draft', 'listed', 'let', 'withdrawn')),
  listed_at           timestamptz,
  closed_at           timestamptz,
  created_by          text NOT NULL REFERENCES users(id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, number)
);
CREATE UNIQUE INDEX pm_listings_one_live ON pm_listings (unit_id) WHERE status IN ('draft', 'listed');

-- ============================================================== collections
CREATE TABLE pm_promises (
  id             text PRIMARY KEY,
  org_id         text NOT NULL REFERENCES organisations(id),
  tenant_id      text NOT NULL REFERENCES contacts(id),
  amount_minor   bigint NOT NULL CHECK (amount_minor > 0),
  promised_date  date NOT NULL,
  balance_minor  bigint NOT NULL,
  paid_before    bigint NOT NULL,
  note           text NOT NULL DEFAULT '',
  cancelled      boolean NOT NULL DEFAULT false,
  recorded_by    text NOT NULL REFERENCES users(id),
  created_at     timestamptz NOT NULL DEFAULT now()
);
COMMENT ON COLUMN pm_promises.paid_before IS 'The tenant''s payments total when the promise was made: kept = paid since ≥ amount by the date.';

CREATE TABLE pm_reminders (
  id          text PRIMARY KEY,
  org_id      text NOT NULL REFERENCES organisations(id),
  invoice_id  text NOT NULL REFERENCES pm_invoices(id),
  tenant_id   text NOT NULL REFERENCES contacts(id),
  stage       integer NOT NULL CHECK (stage BETWEEN 1 AND 3),
  channel     text NOT NULL,
  message_id  text,
  status      text NOT NULL,
  created_by  text REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (invoice_id, stage)
);

CREATE TABLE pm_credit_refunds (
  id            text PRIMARY KEY,
  org_id        text NOT NULL REFERENCES organisations(id),
  number        text NOT NULL,
  tenant_id     text NOT NULL REFERENCES contacts(id),
  amount_minor  bigint NOT NULL CHECK (amount_minor > 0),
  reference     text NOT NULL,
  reason        text NOT NULL,
  status        text NOT NULL CHECK (status IN ('requested', 'approved', 'rejected')),
  requested_by  text NOT NULL REFERENCES users(id),
  approved_by   text REFERENCES users(id),
  rejected_reason text,
  journal_id    text REFERENCES journal_entries(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, number),
  CONSTRAINT credit_refund_second_person CHECK (approved_by IS NULL OR approved_by <> requested_by)
);

CREATE TABLE pm_payment_runs (
  id            text PRIMARY KEY,
  org_id        text NOT NULL REFERENCES organisations(id),
  number        text NOT NULL,
  bill_ids      text[] NOT NULL,
  total_minor   bigint NOT NULL CHECK (total_minor > 0),
  status        text NOT NULL CHECK (status IN ('prepared', 'approved', 'paid', 'cancelled')),
  prepared_by   text NOT NULL REFERENCES users(id),
  approved_by   text REFERENCES users(id),
  paid_by       text REFERENCES users(id),
  paid_date     date,
  reference     text,
  cancel_reason text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, number),
  CONSTRAINT run_approved_by_second_person CHECK (approved_by IS NULL OR approved_by <> prepared_by),
  CONSTRAINT run_paid_by_other_than_approver CHECK (paid_by IS NULL OR paid_by <> approved_by)
);

CREATE TABLE pm_transfers (
  id            text PRIMARY KEY,
  org_id        text NOT NULL REFERENCES organisations(id),
  number        text NOT NULL,
  from_account  text NOT NULL,
  to_account    text NOT NULL,
  amount_minor  bigint NOT NULL CHECK (amount_minor > 0),
  date          date NOT NULL,
  reference     text NOT NULL,
  memo          text NOT NULL,
  status        text NOT NULL CHECK (status IN ('prepared', 'approved', 'rejected')),
  prepared_by   text NOT NULL REFERENCES users(id),
  approved_by   text REFERENCES users(id),
  rejected_reason text,
  journal_id    text REFERENCES journal_entries(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, number),
  CHECK (from_account <> to_account),
  CONSTRAINT transfer_second_person CHECK (approved_by IS NULL OR approved_by <> prepared_by)
);

-- ============================================================== service-charge funds
CREATE TABLE pm_sc_funds (
  id            text PRIMARY KEY,
  org_id        text NOT NULL REFERENCES organisations(id),
  number        text NOT NULL,
  property_id   text NOT NULL REFERENCES pm_properties(id),
  name          text NOT NULL,
  year_start    date NOT NULL,
  year_end      date NOT NULL,
  budget_minor  bigint NOT NULL CHECK (budget_minor > 0),
  method        text NOT NULL CHECK (method IN ('area', 'equal', 'custom')),
  bill_every    integer NOT NULL DEFAULT 1 CHECK (bill_every IN (1, 3, 6, 12)),
  status        text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  created_by    text NOT NULL REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, number),
  CHECK (year_end > year_start)
);

CREATE TABLE pm_sc_shares (
  fund_id   text NOT NULL REFERENCES pm_sc_funds(id),
  unit_id   text NOT NULL REFERENCES pm_units(id),
  org_id    text NOT NULL,
  share_bp  integer NOT NULL CHECK (share_bp BETWEEN 0 AND 10000),
  PRIMARY KEY (fund_id, unit_id)
);

CREATE TABLE pm_sc_billings (
  fund_id     text NOT NULL REFERENCES pm_sc_funds(id),
  period      text NOT NULL CHECK (period ~ '^\d{4}-\d{2}$'),
  lease_id    text NOT NULL REFERENCES pm_leases(id),
  invoice_id  text NOT NULL REFERENCES pm_invoices(id),
  org_id      text NOT NULL,
  PRIMARY KEY (fund_id, period, lease_id)
);

ALTER TABLE pm_invoice_lines ADD CONSTRAINT pm_invoice_lines_fund_fk FOREIGN KEY (fund_id) REFERENCES pm_sc_funds(id);
ALTER TABLE pm_bills ADD CONSTRAINT pm_bills_fund_fk FOREIGN KEY (fund_id) REFERENCES pm_sc_funds(id);
ALTER TABLE pm_ledger_links ADD CONSTRAINT pm_ledger_links_fund_fk FOREIGN KEY (fund_id) REFERENCES pm_sc_funds(id);

-- ============================================================== staff and payroll
CREATE TABLE pm_staff (
  id             text PRIMARY KEY,
  org_id         text NOT NULL REFERENCES organisations(id),
  number         text NOT NULL,
  name           text NOT NULL,
  job_title      text NOT NULL,
  property_id    text REFERENCES pm_properties(id),
  phone          text NOT NULL DEFAULT '',
  email          text NOT NULL DEFAULT '',
  user_id        text REFERENCES users(id),
  gross_minor    bigint NOT NULL CHECK (gross_minor > 0),
  bank_masked    text NOT NULL DEFAULT '',
  start_date     date NOT NULL,
  active         boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, number)
);

CREATE TABLE pm_rosters (
  id           text PRIMARY KEY,
  org_id       text NOT NULL REFERENCES organisations(id),
  staff_id     text NOT NULL REFERENCES pm_staff(id),
  date         date NOT NULL,
  start_time   text NOT NULL CHECK (start_time ~ '^([01]\d|2[0-3]):[0-5]\d$'),
  end_time     text NOT NULL CHECK (end_time ~ '^([01]\d|2[0-3]):[0-5]\d$'),
  post         text NOT NULL DEFAULT '',
  created_by   text NOT NULL REFERENCES users(id),
  UNIQUE (staff_id, date, start_time)
);

CREATE TABLE pm_payroll_deductions (
  id           text PRIMARY KEY,
  org_id       text NOT NULL REFERENCES organisations(id),
  name         text NOT NULL,
  pct_bp       integer NOT NULL DEFAULT 0 CHECK (pct_bp BETWEEN 0 AND 10000),
  fixed_minor  bigint NOT NULL DEFAULT 0 CHECK (fixed_minor >= 0),
  active       boolean NOT NULL DEFAULT true,
  UNIQUE (org_id, name),
  CHECK (pct_bp > 0 OR fixed_minor > 0)
);

CREATE TABLE pm_payroll_runs (
  id                text PRIMARY KEY,
  org_id            text NOT NULL REFERENCES organisations(id),
  number            text NOT NULL,
  period            text NOT NULL CHECK (period ~ '^\d{4}-\d{2}$'),
  status            text NOT NULL CHECK (status IN ('prepared', 'approved', 'paid', 'cancelled')),
  gross_minor       bigint NOT NULL,
  deductions_minor  bigint NOT NULL,
  net_minor         bigint NOT NULL,
  prepared_by       text NOT NULL REFERENCES users(id),
  approved_by       text REFERENCES users(id),
  paid_by           text REFERENCES users(id),
  paid_date         date,
  reference         text,
  journal_id        text REFERENCES journal_entries(id),
  pay_journal_id    text REFERENCES journal_entries(id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, number),
  CONSTRAINT payroll_approved_by_second_person CHECK (approved_by IS NULL OR approved_by <> prepared_by),
  CONSTRAINT payroll_paid_by_other_than_approver CHECK (paid_by IS NULL OR paid_by <> approved_by)
);
CREATE UNIQUE INDEX pm_payroll_runs_one_per_month ON pm_payroll_runs (org_id, period) WHERE status <> 'cancelled';

CREATE TABLE pm_payroll_lines (
  run_id            text NOT NULL REFERENCES pm_payroll_runs(id),
  staff_id          text NOT NULL REFERENCES pm_staff(id),
  org_id            text NOT NULL,
  gross_minor       bigint NOT NULL CHECK (gross_minor > 0),
  deductions        jsonb NOT NULL DEFAULT '[]',
  deductions_minor  bigint NOT NULL CHECK (deductions_minor >= 0),
  net_minor         bigint NOT NULL CHECK (net_minor >= 0),
  PRIMARY KEY (run_id, staff_id)
);

-- ============================================================== assets, loans, stock, renovations, insurance, services
CREATE TABLE pm_assets (
  id                 text PRIMARY KEY,
  org_id             text NOT NULL REFERENCES organisations(id),
  number             text NOT NULL,
  name               text NOT NULL,
  category           text NOT NULL,
  property_id        text REFERENCES pm_properties(id),
  cost_minor         bigint NOT NULL CHECK (cost_minor > 0),
  residual_minor     bigint NOT NULL DEFAULT 0 CHECK (residual_minor >= 0),
  acquired_on        date NOT NULL,
  life_months        integer NOT NULL CHECK (life_months BETWEEN 1 AND 600),
  depreciated_minor  bigint NOT NULL DEFAULT 0,
  status             text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disposed')),
  journal_id         text REFERENCES journal_entries(id),
  created_by         text NOT NULL REFERENCES users(id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, number),
  CHECK (residual_minor < cost_minor),
  CHECK (depreciated_minor BETWEEN 0 AND cost_minor - residual_minor)
);

CREATE TABLE pm_depreciation_runs (
  id            text PRIMARY KEY,
  org_id        text NOT NULL REFERENCES organisations(id),
  period        text NOT NULL CHECK (period ~ '^\d{4}-\d{2}$'),
  amount_minor  bigint NOT NULL,
  journal_id    text REFERENCES journal_entries(id),
  run_by        text NOT NULL REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, period)
);

CREATE TABLE pm_loans (
  id               text PRIMARY KEY,
  org_id           text NOT NULL REFERENCES organisations(id),
  number           text NOT NULL,
  lender           text NOT NULL,
  principal_minor  bigint NOT NULL CHECK (principal_minor > 0),
  rate_pct         numeric(6, 3) NOT NULL CHECK (rate_pct BETWEEN 0 AND 100),
  start_date       date NOT NULL,
  term_months      integer NOT NULL CHECK (term_months BETWEEN 1 AND 600),
  balance_minor    bigint NOT NULL CHECK (balance_minor >= 0),
  journal_id       text REFERENCES journal_entries(id),
  created_by       text NOT NULL REFERENCES users(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, number)
);

CREATE TABLE pm_loan_repayments (
  id               text PRIMARY KEY,
  loan_id          text NOT NULL REFERENCES pm_loans(id),
  org_id           text NOT NULL,
  date             date NOT NULL,
  principal_minor  bigint NOT NULL CHECK (principal_minor >= 0),
  interest_minor   bigint NOT NULL CHECK (interest_minor >= 0),
  reference        text NOT NULL,
  journal_id       text REFERENCES journal_entries(id),
  recorded_by      text NOT NULL REFERENCES users(id),
  CHECK (principal_minor + interest_minor > 0)
);

CREATE TABLE pm_stock_items (
  id              text PRIMARY KEY,
  org_id          text NOT NULL REFERENCES organisations(id),
  sku             text NOT NULL,
  name            text NOT NULL,
  unit_name       text NOT NULL DEFAULT 'each',
  reorder_level   numeric(14, 3) NOT NULL DEFAULT 0 CHECK (reorder_level >= 0),
  quantity        numeric(14, 3) NOT NULL DEFAULT 0 CHECK (quantity >= 0),
  unit_cost_minor bigint NOT NULL DEFAULT 0 CHECK (unit_cost_minor >= 0),
  active          boolean NOT NULL DEFAULT true,
  UNIQUE (org_id, sku)
);

CREATE TABLE pm_stock_moves (
  id             text PRIMARY KEY,
  org_id         text NOT NULL REFERENCES organisations(id),
  item_id        text NOT NULL REFERENCES pm_stock_items(id),
  kind           text NOT NULL CHECK (kind IN ('in', 'out', 'count')),
  quantity       numeric(14, 3) NOT NULL,
  unit_cost_minor bigint NOT NULL DEFAULT 0,
  work_order_id  text REFERENCES pm_work_orders(id),
  note           text NOT NULL DEFAULT '',
  date           date NOT NULL,
  recorded_by    text NOT NULL REFERENCES users(id),
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE pm_renovations (
  id             text PRIMARY KEY,
  org_id         text NOT NULL REFERENCES organisations(id),
  number         text NOT NULL,
  property_id    text NOT NULL REFERENCES pm_properties(id),
  unit_id        text REFERENCES pm_units(id),
  title          text NOT NULL,
  budget_minor   bigint NOT NULL CHECK (budget_minor > 0),
  start_date     date NOT NULL,
  end_date       date,
  status         text NOT NULL CHECK (status IN ('planned', 'in_progress', 'done', 'cancelled')),
  notes          text NOT NULL DEFAULT '',
  created_by     text NOT NULL REFERENCES users(id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, number)
);
ALTER TABLE pm_bills ADD CONSTRAINT pm_bills_renovation_fk FOREIGN KEY (renovation_id) REFERENCES pm_renovations(id);

CREATE TABLE pm_insurance_policies (
  id             text PRIMARY KEY,
  org_id         text NOT NULL REFERENCES organisations(id),
  property_id    text NOT NULL REFERENCES pm_properties(id),
  insurer        text NOT NULL,
  policy_no      text NOT NULL,
  cover          text NOT NULL,
  sum_insured_minor bigint CHECK (sum_insured_minor > 0),
  premium_minor  bigint NOT NULL CHECK (premium_minor >= 0),
  start_date     date NOT NULL,
  end_date       date NOT NULL,
  created_by     text NOT NULL REFERENCES users(id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, insurer, policy_no),
  CHECK (end_date > start_date)
);

CREATE TABLE pm_insurance_claims (
  id              text PRIMARY KEY,
  org_id          text NOT NULL REFERENCES organisations(id),
  number          text NOT NULL,
  policy_id       text NOT NULL REFERENCES pm_insurance_policies(id),
  incident_date   date NOT NULL,
  description     text NOT NULL,
  claimed_minor   bigint NOT NULL CHECK (claimed_minor > 0),
  settled_minor   bigint CHECK (settled_minor >= 0),
  status          text NOT NULL CHECK (status IN ('open', 'settled', 'rejected')),
  outcome_note    text,
  created_by      text NOT NULL REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, number)
);

CREATE TABLE pm_service_schedules (
  id             text PRIMARY KEY,
  org_id         text NOT NULL REFERENCES organisations(id),
  property_id    text NOT NULL REFERENCES pm_properties(id),
  service        text NOT NULL,
  supplier_id    text REFERENCES contacts(id),
  every_months   integer NOT NULL CHECK (every_months BETWEEN 1 AND 60),
  next_due       date NOT NULL,
  last_done      date,
  created_by     text NOT NULL REFERENCES users(id),
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE pm_incidents (
  id            text PRIMARY KEY,
  org_id        text NOT NULL REFERENCES organisations(id),
  number        text NOT NULL,
  property_id   text NOT NULL REFERENCES pm_properties(id),
  kind          text NOT NULL,
  severity      text NOT NULL CHECK (severity IN ('low', 'medium', 'high', 'critical')),
  description   text NOT NULL,
  occurred_at   timestamptz NOT NULL,
  status        text NOT NULL CHECK (status IN ('open', 'closed')),
  closed_note   text,
  reported_by   text NOT NULL REFERENCES users(id),
  closed_by     text REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, number)
);

-- ============================================================== recurring bills and journals
CREATE TABLE pm_recurring_bills (
  id            text PRIMARY KEY,
  org_id        text NOT NULL REFERENCES organisations(id),
  supplier_id   text NOT NULL REFERENCES contacts(id),
  property_id   text REFERENCES pm_properties(id),
  description   text NOT NULL,
  amount_minor  bigint NOT NULL CHECK (amount_minor > 0),
  recover_from  text NOT NULL CHECK (recover_from IN ('owner', 'company')),
  day_of_month  integer NOT NULL CHECK (day_of_month BETWEEN 1 AND 28),
  active        boolean NOT NULL DEFAULT true,
  last_period   text,
  created_by    text NOT NULL REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE pm_bills ADD CONSTRAINT pm_bills_recurring_fk FOREIGN KEY (recurring_id) REFERENCES pm_recurring_bills(id);
CREATE UNIQUE INDEX pm_bills_recurring_once ON pm_bills (recurring_id, bill_date) WHERE recurring_id IS NOT NULL;

CREATE TABLE pm_recurring_journals (
  id            text PRIMARY KEY,
  org_id        text NOT NULL REFERENCES organisations(id),
  memo          text NOT NULL,
  lines         jsonb NOT NULL,
  day_of_month  integer NOT NULL CHECK (day_of_month BETWEEN 1 AND 28),
  active        boolean NOT NULL DEFAULT true,
  last_period   text,
  created_by    text NOT NULL REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- ============================================================== short stays
CREATE TABLE pm_stays (
  id               text PRIMARY KEY,
  org_id           text NOT NULL REFERENCES organisations(id),
  number           text NOT NULL,
  unit_id          text NOT NULL REFERENCES pm_units(id),
  guest_id         text NOT NULL REFERENCES contacts(id),
  check_in         date NOT NULL,
  check_out        date NOT NULL,
  guests           integer NOT NULL DEFAULT 1 CHECK (guests BETWEEN 1 AND 50),
  nightly_minor    bigint NOT NULL CHECK (nightly_minor > 0),
  total_minor      bigint NOT NULL CHECK (total_minor > 0),
  paid_minor       bigint NOT NULL DEFAULT 0 CHECK (paid_minor >= 0),
  status           text NOT NULL CHECK (status IN ('booked', 'checked_in', 'checked_out', 'cancelled')),
  source           text NOT NULL DEFAULT 'direct',
  created_by       text NOT NULL REFERENCES users(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, number),
  CHECK (check_out > check_in),
  CHECK (paid_minor <= total_minor)
);
CREATE INDEX pm_stays_unit ON pm_stays (unit_id, check_in) WHERE status <> 'cancelled';

CREATE TABLE pm_stay_payments (
  id            text PRIMARY KEY,
  org_id        text NOT NULL REFERENCES organisations(id),
  stay_id       text NOT NULL REFERENCES pm_stays(id),
  number        text NOT NULL,
  amount_minor  bigint NOT NULL CHECK (amount_minor > 0),
  method        text NOT NULL,
  reference     text NOT NULL,
  date          date NOT NULL,
  journal_id    text REFERENCES journal_entries(id),
  recorded_by   text NOT NULL REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, number)
);

-- ============================================================== core finance: budgets, tax, exchange rates
CREATE TABLE ledger_budgets (
  org_id        text NOT NULL REFERENCES organisations(id),
  year          integer NOT NULL CHECK (year BETWEEN 2000 AND 2100),
  account_code  text NOT NULL,
  month         integer NOT NULL CHECK (month BETWEEN 1 AND 12),
  amount_minor  bigint NOT NULL,
  updated_by    text REFERENCES users(id),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, year, account_code, month),
  FOREIGN KEY (org_id, account_code) REFERENCES ledger_accounts(org_id, code)
);
COMMENT ON TABLE ledger_budgets IS 'The budget per account and month: income as a positive amount earned, expense as a positive amount spent.';

CREATE TABLE ledger_tax_codes (
  org_id        text NOT NULL REFERENCES organisations(id),
  code          text NOT NULL CHECK (code ~ '^[A-Z0-9_]{1,12}$'),
  name          text NOT NULL,
  rate_bp       integer NOT NULL CHECK (rate_bp BETWEEN 0 AND 10000),
  kind          text NOT NULL CHECK (kind IN ('output', 'input', 'withholding')),
  active        boolean NOT NULL DEFAULT true,
  PRIMARY KEY (org_id, code)
);

CREATE TABLE ledger_tax_returns (
  id                text PRIMARY KEY,
  org_id            text NOT NULL REFERENCES organisations(id),
  number            text NOT NULL,
  period_from       date NOT NULL,
  period_to         date NOT NULL,
  output_minor      bigint NOT NULL,
  input_minor       bigint NOT NULL,
  net_minor         bigint NOT NULL,
  due_date          date NOT NULL,
  status            text NOT NULL CHECK (status IN ('prepared', 'approved', 'filed', 'paid')),
  prepared_by       text NOT NULL REFERENCES users(id),
  approved_by       text REFERENCES users(id),
  filing_reference  text,
  filed_on          date,
  paid_on           date,
  payment_reference text,
  journal_id        text REFERENCES journal_entries(id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, number),
  CHECK (period_to >= period_from),
  CONSTRAINT tax_return_second_person CHECK (approved_by IS NULL OR approved_by <> prepared_by)
);
CREATE UNIQUE INDEX ledger_tax_returns_period ON ledger_tax_returns (org_id, period_from, period_to);

CREATE TABLE ledger_fx_rates (
  org_id      text NOT NULL REFERENCES organisations(id),
  currency    char(3) NOT NULL,
  as_of       date NOT NULL,
  rate        numeric(18, 8) NOT NULL CHECK (rate > 0),
  source      text NOT NULL DEFAULT '',
  recorded_by text REFERENCES users(id),
  PRIMARY KEY (org_id, currency, as_of)
);
COMMENT ON COLUMN ledger_fx_rates.rate IS 'Units of the organisation''s currency for one unit of `currency`, as recorded by finance.';
