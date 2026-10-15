-- Property Management (product "property", the Almas Tower pilot) and the ONE shared CRM contact store.
--
-- Two parts:
--   contacts / contact_*  the organisation's one list of people and companies (tenants, owners, prospects, suppliers),
--                         used by every product; activities and recorded messages hang off it;
--   pm_*                  Property Management records.
--
-- Money is bigint minor units in the organisation's currency; rates are basis points (1 % = 100). Every money movement
-- posts to the ONE ledger (journal_entries) through the ledger service; pm_ledger_links only says which property,
-- owner, tenant and lease a posting belongs to (owner statements and tenant balances read those postings).
--
-- Rules the database itself keeps:
--   * a unit never holds two active leases for overlapping dates (exclusion constraint);
--   * a lease is billed rent at most once per month, recurring charges at most once per month, one deposit invoice,
--     and an overdue invoice carries at most one late fee (unique indexes), so invoice runs are idempotent;
--   * an invoice is never allocated more than its amount, a payment never more than it received;
--   * a bank reference is recorded at most once per method (no double-recorded payment);
--   * second person: deposit refunds, owner payouts (prepare / approve / release), supplier bills (submit / approve /
--     pay), purchase orders, applications and bank reconciliations are decided by someone other than who started them;
--   * one active management agreement per property (or per unit) at a time; at most one open deposit refund per lease.

-- ============================================================== contacts (core, shared by every product)

CREATE TABLE contacts (
  id                 text PRIMARY KEY,
  org_id             text NOT NULL REFERENCES organisations(id),
  name               text NOT NULL CHECK (length(btrim(name)) > 0),
  party_type         text NOT NULL DEFAULT 'individual' CHECK (party_type IN ('individual', 'company')),
  email              text,
  -- dedupe keys: lower-case email; the last 9 digits of the phone number (0712 401 101 = +254 712 401 101)
  email_norm         text GENERATED ALWAYS AS (NULLIF(lower(btrim(email)), '')) STORED,
  phone              text,
  phone_norm         text GENERATED ALWAYS AS (NULLIF(right(regexp_replace(COALESCE(phone, ''), '\D', '', 'g'), 9), '')) STORED,
  types              text[] NOT NULL DEFAULT '{}'
                       CHECK (types <@ ARRAY['tenant', 'owner', 'supplier', 'prospect', 'guarantor', 'other']::text[]),
  tags               text[] NOT NULL DEFAULT '{}',
  tax_id             text,
  address            text,
  notes              text NOT NULL DEFAULT '',
  -- consent per channel: a message on a channel without consent is recorded as blocked
  consent_email      boolean NOT NULL DEFAULT false,
  consent_sms        boolean NOT NULL DEFAULT false,
  consent_whatsapp   boolean NOT NULL DEFAULT false,
  consent_inapp      boolean NOT NULL DEFAULT true,
  consent_marketing  boolean NOT NULL DEFAULT false,
  consent_source     text NOT NULL DEFAULT '',
  consent_at         timestamptz,
  -- a portal sign-in (tenant or owner) linked to this contact
  user_id            text REFERENCES users(id),
  -- merging never deletes: the merged record points at the one kept
  merged_into        text REFERENCES contacts(id),
  merged_at          timestamptz,
  merged_by          text REFERENCES users(id),
  -- set by a data migration: the role the record was imported as (added to types on insert)
  imported_as        text CHECK (imported_as IN ('tenant', 'owner', 'supplier', 'prospect')),
  created_by         text REFERENCES users(id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  source_system      text,
  source_record_id   text,
  mig_job_id         text REFERENCES mig_jobs(id),
  mig_batch_id       text REFERENCES mig_batches(id),
  UNIQUE (org_id, source_system, source_record_id),
  CHECK ((source_system IS NULL) = (source_record_id IS NULL)),
  CONSTRAINT contact_not_merged_into_itself CHECK (merged_into IS NULL OR merged_into <> id)
);
CREATE INDEX contacts_email ON contacts (org_id, email_norm) WHERE merged_into IS NULL;
CREATE INDEX contacts_phone ON contacts (org_id, phone_norm) WHERE merged_into IS NULL;
CREATE INDEX contacts_name ON contacts (org_id, lower(name));
CREATE UNIQUE INDEX contacts_user ON contacts (org_id, user_id) WHERE user_id IS NOT NULL;

CREATE FUNCTION contacts_add_imported_type() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.imported_as IS NOT NULL AND NOT (NEW.imported_as = ANY (NEW.types)) THEN
    NEW.types := NEW.types || NEW.imported_as;
  END IF;
  IF NEW.mig_job_id IS NOT NULL AND NEW.consent_source = '' THEN
    NEW.consent_source := 'Data migration (no consent recorded in the source)';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER contacts_imported_type BEFORE INSERT ON contacts
  FOR EACH ROW EXECUTE FUNCTION contacts_add_imported_type();

-- what happened with a contact: notes, calls, meetings, stage changes, viewings, leases (newest first in the API)
CREATE TABLE contact_activities (
  id          text PRIMARY KEY,
  org_id      text NOT NULL REFERENCES organisations(id),
  contact_id  text NOT NULL REFERENCES contacts(id),
  kind        text NOT NULL CHECK (kind IN ('note', 'call', 'meeting', 'email', 'enquiry', 'stage', 'viewing',
                'application', 'lease', 'maintenance', 'payment', 'message', 'system')),
  text        text NOT NULL,
  ref_type    text,
  ref_id      text,
  at          timestamptz NOT NULL DEFAULT now(),
  by_user     text REFERENCES users(id)
);
CREATE INDEX contact_activities_contact ON contact_activities (contact_id, at DESC);

-- the CRM's message log per contact. An outgoing e-mail / SMS / WhatsApp is also handed to the one notifications
-- outbox (outbox_id), which alone talks to delivery providers; nothing here is ever "sent".
-- Blocked = no consent for that channel (or for marketing), or no address.
CREATE TABLE contact_messages (
  id               text PRIMARY KEY,
  org_id           text NOT NULL REFERENCES organisations(id),
  contact_id       text NOT NULL REFERENCES contacts(id),
  channel          text NOT NULL CHECK (channel IN ('email', 'sms', 'whatsapp', 'inapp', 'note')),
  direction        text NOT NULL CHECK (direction IN ('out', 'in')),
  subject          text NOT NULL DEFAULT '',
  body             text NOT NULL,
  status           text NOT NULL CHECK (status IN ('recorded', 'blocked', 'received', 'internal')),
  reason           text NOT NULL DEFAULT '',
  marketing        boolean NOT NULL DEFAULT false,
  ref_type         text,
  ref_id           text,
  idempotency_key  text,
  -- the notifications outbox record (core/notifications) for e-mail, SMS and WhatsApp
  outbox_id        text,
  recorded_by      text REFERENCES users(id),
  at               timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX contact_messages_contact ON contact_messages (contact_id, at DESC);
CREATE UNIQUE INDEX contact_messages_key ON contact_messages (org_id, idempotency_key) WHERE idempotency_key IS NOT NULL;

-- ============================================================== Property Management: configuration

-- organisation-wide PM settings. No amount is hard-coded: limits start at zero until the organisation sets them.
CREATE TABLE pm_settings (
  org_id                  text PRIMARY KEY REFERENCES organisations(id),
  -- VAT on management fees and VAT-able agency charges (0 = not VAT-registered), from a date
  vat_bp                  integer NOT NULL DEFAULT 0 CHECK (vat_bp BETWEEN 0 AND 5000),
  vat_from                date,
  -- purchase-order approval limits by role (finance director and org admin: unlimited)
  po_limits               jsonb NOT NULL DEFAULT '{}',
  -- supplier invoice may exceed its purchase order by this much before it is held
  match_tolerance_bp      integer NOT NULL DEFAULT 200 CHECK (match_tolerance_bp BETWEEN 0 AND 5000),
  -- days to finish a work order, by priority
  sla_days                jsonb NOT NULL DEFAULT '{"urgent": 1, "high": 3, "normal": 7, "low": 14}',
  updated_by              text REFERENCES users(id),
  updated_at              timestamptz NOT NULL DEFAULT now()
);

-- what can be billed besides rent: service charge, metered water, parking, admin fee … (prices are rows, not code)
CREATE TABLE pm_charge_types (
  id           text PRIMARY KEY,
  org_id       text NOT NULL REFERENCES organisations(id),
  code         text NOT NULL,
  name         text NOT NULL,
  -- owner: the owner's money (Cr 2150 → 2250 when collected); agency: the agency's income (Cr 2170 → 4660)
  payee        text NOT NULL CHECK (payee IN ('owner', 'agency')),
  -- the management fee is taken on this charge when collected (owner charges only)
  fee_applies  boolean NOT NULL DEFAULT false,
  -- VAT-inclusive agency charge (VAT split out when collected)
  vat_applies  boolean NOT NULL DEFAULT false,
  metered      boolean NOT NULL DEFAULT false,
  unit_name    text NOT NULL DEFAULT '',
  -- metered: price per unit consumed (minor units); otherwise the default amount (0 = set per lease)
  rate_minor   bigint NOT NULL DEFAULT 0 CHECK (rate_minor >= 0),
  active       boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, code),
  CHECK (payee = 'owner' OR NOT fee_applies)
);

-- ============================================================== portfolio

CREATE TABLE pm_properties (
  id                   text PRIMARY KEY,
  org_id               text NOT NULL REFERENCES organisations(id),
  name                 text NOT NULL,
  address              text NOT NULL DEFAULT '',
  kind                 text NOT NULL DEFAULT 'residential' CHECK (kind IN ('residential', 'commercial', 'mixed')),
  -- late-fee policy: a percentage of the overdue balance (at least min) once the grace days have passed
  late_fee_enabled     boolean NOT NULL DEFAULT false,
  late_fee_bp          integer NOT NULL DEFAULT 0 CHECK (late_fee_bp BETWEEN 0 AND 5000),
  late_fee_grace_days  integer NOT NULL DEFAULT 0 CHECK (late_fee_grace_days BETWEEN 0 AND 90),
  late_fee_min_minor   bigint NOT NULL DEFAULT 0 CHECK (late_fee_min_minor >= 0),
  late_fee_payee       text NOT NULL DEFAULT 'owner' CHECK (late_fee_payee IN ('owner', 'agency')),
  -- automation through the PALTAS scheduler: the monthly billing run on a day of the month, late fees every day
  auto_billing         boolean NOT NULL DEFAULT false,
  auto_billing_day     integer NOT NULL DEFAULT 1 CHECK (auto_billing_day BETWEEN 1 AND 28),
  auto_late_fees       boolean NOT NULL DEFAULT false,
  created_by           text REFERENCES users(id),
  created_at           timestamptz NOT NULL DEFAULT now(),
  source_system        text,
  source_record_id     text,
  mig_job_id           text REFERENCES mig_jobs(id),
  mig_batch_id         text REFERENCES mig_batches(id),
  UNIQUE (org_id, source_system, source_record_id),
  CHECK ((source_system IS NULL) = (source_record_id IS NULL))
);
CREATE UNIQUE INDEX pm_properties_name ON pm_properties (org_id, lower(name));

-- blocks / towers inside a property
CREATE TABLE pm_buildings (
  id           text PRIMARY KEY,
  org_id       text NOT NULL REFERENCES organisations(id),
  property_id  text NOT NULL REFERENCES pm_properties(id),
  name         text NOT NULL,
  floors       integer CHECK (floors BETWEEN 0 AND 300),
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX pm_buildings_name ON pm_buildings (property_id, lower(name));

CREATE TABLE pm_units (
  id                 text PRIMARY KEY,
  org_id             text NOT NULL REFERENCES organisations(id),
  property_id        text NOT NULL REFERENCES pm_properties(id),
  building_id        text REFERENCES pm_buildings(id),
  unit_no            text NOT NULL,
  floor              text,
  unit_type          text,
  bedrooms           integer CHECK (bedrooms BETWEEN 0 AND 50),
  area_sqm           numeric(10, 2) CHECK (area_sqm >= 0),
  market_rent_minor  bigint CHECK (market_rent_minor >= 0),
  -- off_market: not lettable (renovation, owner use); occupancy itself comes from leases
  status             text NOT NULL DEFAULT 'available' CHECK (status IN ('available', 'off_market')),
  created_at         timestamptz NOT NULL DEFAULT now(),
  source_system      text,
  source_record_id   text,
  mig_job_id         text REFERENCES mig_jobs(id),
  mig_batch_id       text REFERENCES mig_batches(id),
  UNIQUE (org_id, source_system, source_record_id),
  CHECK ((source_system IS NULL) = (source_record_id IS NULL))
);
CREATE UNIQUE INDEX pm_units_number ON pm_units (property_id, upper(unit_no));
CREATE INDEX pm_units_org_number ON pm_units (org_id, upper(unit_no));

-- payout details per owner (an owner is a contact). Bank details are kept masked; verification is recorded.
CREATE TABLE pm_owner_profiles (
  owner_id            text PRIMARY KEY REFERENCES contacts(id),
  org_id              text NOT NULL REFERENCES organisations(id),
  bank_account_masked text NOT NULL DEFAULT '',
  bank_verified_at    timestamptz,
  bank_verified_by    text REFERENCES users(id),
  -- kept back from every payout (e.g. for upcoming repairs)
  reserve_minor       bigint NOT NULL DEFAULT 0 CHECK (reserve_minor >= 0),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

-- the owner's mandate: who owns the property (or one unit of it), the management fee, the spending authority
CREATE TABLE pm_agreements (
  id               text PRIMARY KEY,
  org_id           text NOT NULL REFERENCES organisations(id),
  number           text NOT NULL,
  property_id      text NOT NULL REFERENCES pm_properties(id),
  -- NULL = the whole property; otherwise this unit only (an individually owned apartment)
  unit_id          text REFERENCES pm_units(id),
  owner_id         text NOT NULL REFERENCES contacts(id),
  fee_bp           integer NOT NULL CHECK (fee_bp BETWEEN 0 AND 3000),
  -- bills above this need the owner's approval
  authority_minor  bigint NOT NULL CHECK (authority_minor >= 0),
  payout_day       integer NOT NULL DEFAULT 10 CHECK (payout_day BETWEEN 1 AND 28),
  start_date       date NOT NULL,
  end_date         date,
  status           text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'ended')),
  created_by       text REFERENCES users(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, number),
  CHECK (end_date IS NULL OR end_date >= start_date)
);
CREATE UNIQUE INDEX pm_agreements_one_active ON pm_agreements (property_id, COALESCE(unit_id, ''))
  WHERE status = 'active';

-- ============================================================== leases

CREATE TABLE pm_leases (
  id                       text PRIMARY KEY,
  org_id                   text NOT NULL REFERENCES organisations(id),
  number                   text,
  property_id              text NOT NULL REFERENCES pm_properties(id),
  unit_id                  text NOT NULL REFERENCES pm_units(id),
  tenant_id                text NOT NULL REFERENCES contacts(id),
  -- draft → active → ended (moved out / terminated); a draft can be cancelled
  status                   text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'ended', 'cancelled')),
  start_date               date NOT NULL,
  -- NULL = periodic (month to month)
  end_date                 date,
  rent_minor               bigint NOT NULL CHECK (rent_minor > 0),
  deposit_minor            bigint NOT NULL DEFAULT 0 CHECK (deposit_minor >= 0),
  -- collect: a deposit invoice is issued at activation; held: transferred in (opening balance); none
  deposit_mode             text NOT NULL DEFAULT 'collect' CHECK (deposit_mode IN ('collect', 'held', 'none')),
  due_day                  integer NOT NULL DEFAULT 5 CHECK (due_day BETWEEN 1 AND 28),
  -- automatic escalation: +escalation_bp every escalation_months (rent steps written at activation)
  escalation_bp            integer NOT NULL DEFAULT 0 CHECK (escalation_bp BETWEEN 0 AND 5000),
  escalation_months        integer CHECK (escalation_months BETWEEN 1 AND 120),
  notice_days              integer NOT NULL DEFAULT 30 CHECK (notice_days BETWEEN 0 AND 365),
  notice_given_on          date,
  move_out_date            date,
  ended_reason             text,
  signed_on                date,
  application_id           text,
  activated_by             text REFERENCES users(id),
  activated_at             timestamptz,
  created_by               text REFERENCES users(id),
  created_at               timestamptz NOT NULL DEFAULT now(),
  -- data migration: the unit is given by its number and resolved on insert (the unit is set up in PALTAS first), or
  -- is a unit of the same upload (upload_unit_id)
  migrated_unit_no         text,
  upload_unit_id           text REFERENCES pm_units(id),
  migrated                 boolean NOT NULL DEFAULT false,
  source_system            text,
  source_record_id         text,
  mig_job_id               text REFERENCES mig_jobs(id),
  mig_batch_id             text REFERENCES mig_batches(id),
  UNIQUE (org_id, number),
  UNIQUE (org_id, source_system, source_record_id),
  CHECK ((source_system IS NULL) = (source_record_id IS NULL)),
  CHECK (end_date IS NULL OR end_date >= start_date),
  CHECK (escalation_bp = 0 OR escalation_months IS NOT NULL),
  CONSTRAINT pm_unit_not_double_let EXCLUDE USING gist
    (unit_id WITH =, daterange(start_date, end_date, '[]') WITH &&) WHERE (status = 'active')
);
CREATE INDEX pm_leases_tenant ON pm_leases (tenant_id);
CREATE INDEX pm_leases_property ON pm_leases (property_id, status);

-- migrated leases name their unit by number; resolve it (and give the lease a number) as it is inserted
CREATE FUNCTION pm_leases_resolve_migrated() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  hits integer;
BEGIN
  IF NEW.unit_id IS NULL AND NEW.upload_unit_id IS NOT NULL THEN
    NEW.unit_id := NEW.upload_unit_id;
  END IF;
  IF NEW.unit_id IS NULL AND NEW.migrated_unit_no IS NOT NULL THEN
    SELECT count(*) INTO hits FROM pm_units WHERE org_id = NEW.org_id AND upper(unit_no) = upper(btrim(NEW.migrated_unit_no));
    IF hits <> 1 THEN
      RAISE EXCEPTION 'Unit % is % in PALTAS', NEW.migrated_unit_no, CASE WHEN hits = 0 THEN 'not set up' ELSE 'ambiguous' END
        USING ERRCODE = 'PA005';
    END IF;
    SELECT id, property_id INTO NEW.unit_id, NEW.property_id FROM pm_units
      WHERE org_id = NEW.org_id AND upper(unit_no) = upper(btrim(NEW.migrated_unit_no));
  END IF;
  IF NEW.property_id IS NULL AND NEW.unit_id IS NOT NULL THEN
    SELECT property_id INTO NEW.property_id FROM pm_units WHERE id = NEW.unit_id;
  END IF;
  IF NEW.number IS NULL THEN
    NEW.number := 'LSM-' || upper(right(NEW.id, 10));
  END IF;
  IF NEW.mig_job_id IS NOT NULL THEN
    NEW.migrated := true;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER pm_leases_migrated BEFORE INSERT ON pm_leases
  FOR EACH ROW EXECUTE FUNCTION pm_leases_resolve_migrated();

-- the rent from a date on (start, escalations, renewals, reviews); the latest step on or before a date applies
CREATE TABLE pm_rent_steps (
  lease_id        text NOT NULL REFERENCES pm_leases(id),
  org_id          text NOT NULL,
  effective_from  date NOT NULL,
  rent_minor      bigint NOT NULL CHECK (rent_minor > 0),
  reason          text NOT NULL CHECK (reason IN ('start', 'escalation', 'renewal', 'review')),
  created_by      text REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (lease_id, effective_from)
);

-- recurring charges on a lease (service charge, parking …); metered charges have no amount (billed from readings)
CREATE TABLE pm_lease_charges (
  lease_id        text NOT NULL REFERENCES pm_leases(id),
  charge_type_id  text NOT NULL REFERENCES pm_charge_types(id),
  org_id          text NOT NULL,
  amount_minor    bigint CHECK (amount_minor > 0),
  PRIMARY KEY (lease_id, charge_type_id)
);

CREATE TABLE pm_meter_readings (
  id              text PRIMARY KEY,
  org_id          text NOT NULL REFERENCES organisations(id),
  unit_id         text NOT NULL REFERENCES pm_units(id),
  charge_type_id  text NOT NULL REFERENCES pm_charge_types(id),
  period          char(7) NOT NULL CHECK (period ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  previous        numeric(14, 3) NOT NULL CHECK (previous >= 0),
  current         numeric(14, 3) NOT NULL,
  recorded_by     text REFERENCES users(id),
  recorded_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (unit_id, charge_type_id, period),
  CHECK (current >= previous)
);

-- ============================================================== invoices, payments, allocations

CREATE TABLE pm_billing_runs (
  id           text PRIMARY KEY,
  org_id       text NOT NULL REFERENCES organisations(id),
  property_id  text NOT NULL REFERENCES pm_properties(id),
  period       char(7) NOT NULL,
  kind         text NOT NULL CHECK (kind IN ('rent', 'charges')),
  created      integer NOT NULL,
  skipped      integer NOT NULL,
  -- NULL: run by the PALTAS scheduler
  run_by       text REFERENCES users(id),
  at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX pm_billing_runs_property ON pm_billing_runs (property_id, period);

CREATE TABLE pm_invoices (
  id                     text PRIMARY KEY,
  org_id                 text NOT NULL REFERENCES organisations(id),
  number                 text,
  -- opening: an open invoice brought over from the previous system (already income there)
  kind                   text NOT NULL CHECK (kind IN ('rent', 'deposit', 'charge', 'late_fee', 'opening')),
  lease_id               text REFERENCES pm_leases(id),
  tenant_id              text NOT NULL REFERENCES contacts(id),
  unit_id                text REFERENCES pm_units(id),
  property_id            text REFERENCES pm_properties(id),
  -- the owner and the agreement (fee rate) in force when it was issued
  owner_id               text REFERENCES contacts(id),
  agreement_id           text REFERENCES pm_agreements(id),
  period                 char(7),
  issue_date             date NOT NULL,
  due_date               date NOT NULL,
  amount_minor           bigint NOT NULL CHECK (amount_minor > 0),
  original_amount_minor  bigint,
  note                   text NOT NULL DEFAULT '',
  recurring              boolean NOT NULL DEFAULT false,
  -- a late fee names the overdue invoice it is charged on
  source_invoice_id      text REFERENCES pm_invoices(id),
  run_id                 text REFERENCES pm_billing_runs(id),
  journal_id             text REFERENCES journal_entries(id),
  created_by             text REFERENCES users(id),
  created_at             timestamptz NOT NULL DEFAULT now(),
  source_system          text,
  source_record_id       text,
  mig_job_id             text REFERENCES mig_jobs(id),
  mig_batch_id           text REFERENCES mig_batches(id),
  UNIQUE (org_id, number),
  UNIQUE (org_id, source_system, source_record_id),
  CHECK ((source_system IS NULL) = (source_record_id IS NULL)),
  CHECK (kind = 'opening' OR (lease_id IS NOT NULL AND owner_id IS NOT NULL)),
  CHECK (kind <> 'late_fee' OR source_invoice_id IS NOT NULL),
  CHECK (due_date >= issue_date OR kind = 'opening')
);
CREATE UNIQUE INDEX pm_invoices_rent_once ON pm_invoices (lease_id, period) WHERE kind = 'rent';
CREATE UNIQUE INDEX pm_invoices_charges_once ON pm_invoices (lease_id, period) WHERE kind = 'charge' AND recurring;
CREATE UNIQUE INDEX pm_invoices_deposit_once ON pm_invoices (lease_id) WHERE kind = 'deposit';
CREATE UNIQUE INDEX pm_invoices_late_once ON pm_invoices (source_invoice_id) WHERE kind = 'late_fee';
CREATE INDEX pm_invoices_tenant ON pm_invoices (tenant_id, due_date);

CREATE FUNCTION pm_invoices_number_opening() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.number IS NULL THEN
    NEW.number := 'OB-' || COALESCE(NEW.source_record_id, upper(right(NEW.id, 10)));
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER pm_invoices_number BEFORE INSERT ON pm_invoices
  FOR EACH ROW EXECUTE FUNCTION pm_invoices_number_opening();

CREATE TABLE pm_invoice_lines (
  invoice_id      text NOT NULL REFERENCES pm_invoices(id),
  line_no         integer NOT NULL,
  org_id          text NOT NULL,
  code            text NOT NULL,
  description     text NOT NULL,
  quantity        numeric(14, 3) NOT NULL DEFAULT 1,
  rate_minor      bigint NOT NULL,
  amount_minor    bigint NOT NULL CHECK (amount_minor > 0),
  -- owner: Cr 2150; agency: Cr 2170; deposit: Cr 2160
  payee           text NOT NULL CHECK (payee IN ('owner', 'agency', 'deposit')),
  fee_applies     boolean NOT NULL DEFAULT false,
  vat_applies     boolean NOT NULL DEFAULT false,
  PRIMARY KEY (invoice_id, line_no)
);

-- payments RECORDED by staff (bank transfer, mobile money, cash, cheque): PALTAS never processes a payment
CREATE TABLE pm_payments (
  id              text PRIMARY KEY,
  org_id          text NOT NULL REFERENCES organisations(id),
  number          text NOT NULL,
  receipt_number  text NOT NULL,
  tenant_id       text NOT NULL REFERENCES contacts(id),
  date            date NOT NULL,
  amount_minor    bigint NOT NULL CHECK (amount_minor > 0),
  method          text NOT NULL CHECK (method IN ('bank_transfer', 'mobile_money', 'cash', 'cheque', 'card', 'other')),
  reference       text NOT NULL CHECK (length(btrim(reference)) > 0),
  note            text NOT NULL DEFAULT '',
  claim_id        text,
  bank_line_id    text,
  journal_id      text REFERENCES journal_entries(id),
  recorded_by     text NOT NULL REFERENCES users(id),
  recorded_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, number),
  UNIQUE (org_id, receipt_number)
);
CREATE UNIQUE INDEX pm_payments_reference ON pm_payments (org_id, method, upper(btrim(reference)));
CREATE INDEX pm_payments_tenant ON pm_payments (tenant_id, date);

CREATE TABLE pm_credit_notes (
  id            text PRIMARY KEY,
  org_id        text NOT NULL REFERENCES organisations(id),
  number        text NOT NULL,
  invoice_id    text NOT NULL REFERENCES pm_invoices(id),
  amount_minor  bigint NOT NULL CHECK (amount_minor > 0),
  reason        text NOT NULL,
  date          date NOT NULL,
  journal_id    text REFERENCES journal_entries(id),
  created_by    text NOT NULL REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, number)
);

-- deposits held at move-out: arrears applied, deductions to the owner, the rest refunded — decided by a second person
CREATE TABLE pm_deposit_refunds (
  id                 text PRIMARY KEY,
  org_id             text NOT NULL REFERENCES organisations(id),
  number             text NOT NULL,
  lease_id           text NOT NULL REFERENCES pm_leases(id),
  tenant_id          text NOT NULL REFERENCES contacts(id),
  held_minor         bigint NOT NULL CHECK (held_minor > 0),
  arrears_minor      bigint NOT NULL CHECK (arrears_minor >= 0),
  deductions_minor   bigint NOT NULL CHECK (deductions_minor >= 0),
  deductions         jsonb NOT NULL DEFAULT '[]',
  refund_minor       bigint NOT NULL CHECK (refund_minor >= 0),
  refund_reference   text NOT NULL DEFAULT '',
  status             text NOT NULL CHECK (status IN ('requested', 'approved', 'rejected')),
  requested_by       text NOT NULL REFERENCES users(id),
  requested_at       timestamptz NOT NULL DEFAULT now(),
  decided_by         text REFERENCES users(id),
  decided_at         timestamptz,
  reject_reason      text,
  bank_line_id       text,
  journal_id         text REFERENCES journal_entries(id),
  UNIQUE (org_id, number),
  CHECK (held_minor = arrears_minor + deductions_minor + refund_minor),
  CONSTRAINT deposit_refund_second_person CHECK (decided_by IS NULL OR decided_by <> requested_by)
);
CREATE UNIQUE INDEX pm_deposit_refunds_open ON pm_deposit_refunds (lease_id) WHERE status IN ('requested', 'approved');

-- money applied to an invoice: from a payment, from the tenant's credit, from the deposit at move-out, or a credit note
CREATE TABLE pm_allocations (
  id                 text PRIMARY KEY,
  org_id             text NOT NULL REFERENCES organisations(id),
  invoice_id         text NOT NULL REFERENCES pm_invoices(id),
  amount_minor       bigint NOT NULL CHECK (amount_minor > 0),
  source             text NOT NULL CHECK (source IN ('payment', 'credit', 'deposit', 'credit_note')),
  payment_id         text REFERENCES pm_payments(id),
  deposit_refund_id  text REFERENCES pm_deposit_refunds(id),
  credit_note_id     text REFERENCES pm_credit_notes(id),
  date               date NOT NULL,
  journal_id         text REFERENCES journal_entries(id),
  created_by         text REFERENCES users(id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  CHECK ((source = 'payment') = (payment_id IS NOT NULL)),
  CHECK ((source = 'deposit') = (deposit_refund_id IS NOT NULL)),
  CHECK ((source = 'credit_note') = (credit_note_id IS NOT NULL))
);
CREATE INDEX pm_allocations_invoice ON pm_allocations (invoice_id);
CREATE INDEX pm_allocations_payment ON pm_allocations (payment_id) WHERE payment_id IS NOT NULL;

CREATE FUNCTION pm_allocations_within_limits() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  inv_amount bigint;
  inv_alloc bigint;
  pay_amount bigint;
  pay_alloc bigint;
BEGIN
  SELECT amount_minor INTO inv_amount FROM pm_invoices WHERE id = NEW.invoice_id;
  SELECT COALESCE(sum(amount_minor), 0) INTO inv_alloc FROM pm_allocations WHERE invoice_id = NEW.invoice_id;
  IF inv_alloc > inv_amount THEN
    RAISE EXCEPTION 'Invoice % would be allocated % of %', NEW.invoice_id, inv_alloc, inv_amount USING ERRCODE = 'PA005';
  END IF;
  IF NEW.payment_id IS NOT NULL THEN
    SELECT amount_minor INTO pay_amount FROM pm_payments WHERE id = NEW.payment_id;
    SELECT COALESCE(sum(amount_minor), 0) INTO pay_alloc FROM pm_allocations WHERE payment_id = NEW.payment_id;
    IF pay_alloc > pay_amount THEN
      RAISE EXCEPTION 'Payment % would be allocated % of %', NEW.payment_id, pay_alloc, pay_amount USING ERRCODE = 'PA005';
    END IF;
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER pm_allocations_limits AFTER INSERT ON pm_allocations
  DEFERRABLE INITIALLY IMMEDIATE FOR EACH ROW EXECUTE FUNCTION pm_allocations_within_limits();

-- payments a tenant reports from the portal: a claim staff check against the bank, never a payment by itself
CREATE TABLE pm_payment_claims (
  id            text PRIMARY KEY,
  org_id        text NOT NULL REFERENCES organisations(id),
  tenant_id     text NOT NULL REFERENCES contacts(id),
  amount_minor  bigint NOT NULL CHECK (amount_minor > 0),
  date          date NOT NULL,
  method        text NOT NULL,
  reference     text NOT NULL,
  note          text NOT NULL DEFAULT '',
  status        text NOT NULL CHECK (status IN ('pending', 'matched', 'rejected')),
  submitted_by  text NOT NULL REFERENCES users(id),
  submitted_at  timestamptz NOT NULL DEFAULT now(),
  decided_by    text REFERENCES users(id),
  decided_at    timestamptz,
  payment_id    text REFERENCES pm_payments(id),
  reason        text
);

-- money brought over by a data migration, per tenant (deposits) and per owner (owner funds)
CREATE TABLE pm_opening_deposits (
  id                text PRIMARY KEY,
  org_id            text NOT NULL REFERENCES organisations(id),
  tenant_id         text NOT NULL REFERENCES contacts(id),
  amount_minor      bigint NOT NULL CHECK (amount_minor > 0),
  as_of             date,
  created_at        timestamptz NOT NULL DEFAULT now(),
  source_system     text,
  source_record_id  text,
  mig_job_id        text REFERENCES mig_jobs(id),
  mig_batch_id      text REFERENCES mig_batches(id),
  UNIQUE (org_id, source_system, source_record_id),
  CHECK ((source_system IS NULL) = (source_record_id IS NULL))
);

-- the source system's chart of accounts and trial balance at the cut-over (kept for the reconciliation)
CREATE TABLE pm_source_accounts (
  id                text PRIMARY KEY,
  org_id            text NOT NULL REFERENCES organisations(id),
  name              text NOT NULL,
  type              text,
  detail_type       text,
  description       text,
  balance_minor     bigint,
  created_at        timestamptz NOT NULL DEFAULT now(),
  source_system     text,
  source_record_id  text,
  mig_job_id        text REFERENCES mig_jobs(id),
  mig_batch_id      text REFERENCES mig_batches(id),
  UNIQUE (org_id, source_system, source_record_id),
  CHECK ((source_system IS NULL) = (source_record_id IS NULL))
);

CREATE TABLE pm_trial_balance_lines (
  id                text PRIMARY KEY,
  org_id            text NOT NULL REFERENCES organisations(id),
  account           text NOT NULL,
  debit_minor       bigint CHECK (debit_minor >= 0),
  credit_minor      bigint CHECK (credit_minor >= 0),
  -- the PALTAS account this balance belongs to (1040 client bank, 1120 tenant receivables, 2300 deposits, 2250 owner
  -- funds, 2000 payables) or skip
  paltas_account    text NOT NULL CHECK (paltas_account IN ('1040', '1120', '2300', '2250', '2000', 'skip')),
  owner_id          text REFERENCES contacts(id),
  as_of             date,
  created_at        timestamptz NOT NULL DEFAULT now(),
  source_system     text,
  source_record_id  text,
  mig_job_id        text REFERENCES mig_jobs(id),
  mig_batch_id      text REFERENCES mig_batches(id),
  UNIQUE (org_id, source_system, source_record_id),
  CHECK ((source_system IS NULL) = (source_record_id IS NULL))
);

-- ============================================================== owners: bills, payouts

CREATE TABLE pm_maintenance_requests (
  id                   text PRIMARY KEY,
  org_id               text NOT NULL REFERENCES organisations(id),
  number               text NOT NULL,
  property_id          text NOT NULL REFERENCES pm_properties(id),
  unit_id              text REFERENCES pm_units(id),
  reporter_id          text REFERENCES contacts(id),
  title                text NOT NULL,
  category             text NOT NULL DEFAULT 'general',
  priority             text NOT NULL CHECK (priority IN ('urgent', 'high', 'normal', 'low')),
  status               text NOT NULL CHECK (status IN ('open', 'assigned', 'resolved', 'closed')),
  source               text NOT NULL CHECK (source IN ('staff', 'tenant_portal', 'inspection')),
  opened_by            text NOT NULL REFERENCES users(id),
  opened_at            timestamptz NOT NULL DEFAULT now(),
  resolved_at          timestamptz,
  UNIQUE (org_id, number)
);

CREATE TABLE pm_work_orders (
  id                 text PRIMARY KEY,
  org_id             text NOT NULL REFERENCES organisations(id),
  number             text NOT NULL,
  property_id        text NOT NULL REFERENCES pm_properties(id),
  unit_id            text REFERENCES pm_units(id),
  request_id         text REFERENCES pm_maintenance_requests(id),
  scope              text NOT NULL,
  priority           text NOT NULL CHECK (priority IN ('urgent', 'high', 'normal', 'low')),
  status             text NOT NULL CHECK (status IN ('requesting_quotes', 'quoted', 'po_pending', 'awaiting_owner',
                       'approved', 'completed', 'verified', 'billed', 'cancelled')),
  due_date           date NOT NULL,
  po_number          text,
  po_supplier_id     text REFERENCES contacts(id),
  po_amount_minor    bigint CHECK (po_amount_minor > 0),
  po_raised_by       text REFERENCES users(id),
  po_approved_by     text REFERENCES users(id),
  needs_owner        boolean NOT NULL DEFAULT false,
  owner_approved_by  text REFERENCES users(id),
  completed_by       text REFERENCES users(id),
  completed_at       timestamptz,
  completion_notes   text,
  evidence           jsonb NOT NULL DEFAULT '[]',
  verified_by        text REFERENCES users(id),
  verified_at        timestamptz,
  created_by         text NOT NULL REFERENCES users(id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, number),
  CONSTRAINT po_approved_by_second_person CHECK (po_approved_by IS NULL OR po_approved_by <> po_raised_by)
);

CREATE TABLE pm_wo_quotes (
  work_order_id  text NOT NULL REFERENCES pm_work_orders(id),
  supplier_id    text NOT NULL REFERENCES contacts(id),
  org_id         text NOT NULL,
  amount_minor   bigint NOT NULL CHECK (amount_minor > 0),
  days           integer CHECK (days BETWEEN 0 AND 365),
  file_name      text NOT NULL,
  recorded_by    text NOT NULL REFERENCES users(id),
  recorded_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (work_order_id, supplier_id)
);

CREATE TABLE pm_inspections (
  id              text PRIMARY KEY,
  org_id          text NOT NULL REFERENCES organisations(id),
  number          text NOT NULL,
  property_id     text NOT NULL REFERENCES pm_properties(id),
  unit_id         text REFERENCES pm_units(id),
  lease_id        text REFERENCES pm_leases(id),
  kind            text NOT NULL CHECK (kind IN ('move_in', 'move_out', 'routine')),
  scheduled_date  date NOT NULL,
  status          text NOT NULL CHECK (status IN ('scheduled', 'completed')),
  items           jsonb NOT NULL DEFAULT '[]',
  completed_by    text REFERENCES users(id),
  completed_at    timestamptz,
  created_by      text NOT NULL REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, number)
);
-- a request opened from an inspection item points at the inspection
ALTER TABLE pm_maintenance_requests ADD COLUMN inspection_id text REFERENCES pm_inspections(id);

-- supplier bills: submitted → (held on a match exception) → approved (→ awaiting owner above the authority) → paid
CREATE TABLE pm_bills (
  id                   text PRIMARY KEY,
  org_id               text NOT NULL REFERENCES organisations(id),
  number               text,
  supplier_id          text NOT NULL REFERENCES contacts(id),
  property_id          text REFERENCES pm_properties(id),
  unit_id              text REFERENCES pm_units(id),
  work_order_id        text REFERENCES pm_work_orders(id),
  description          text NOT NULL DEFAULT '',
  supplier_invoice_no  text,
  bill_date            date NOT NULL,
  due_date             date,
  amount_minor         bigint NOT NULL CHECK (amount_minor > 0),
  -- owner: charged to the owner's funds (Dr 2250); company: the agency's own cost (Dr 5650)
  recover_from         text NOT NULL DEFAULT 'owner' CHECK (recover_from IN ('owner', 'company')),
  owner_id             text REFERENCES contacts(id),
  status               text NOT NULL DEFAULT 'approved'
                         CHECK (status IN ('submitted', 'held', 'awaiting_owner', 'approved', 'rejected', 'paid')),
  match_issues         jsonb NOT NULL DEFAULT '[]',
  hold_cleared_by      text REFERENCES users(id),
  hold_cleared_reason  text,
  submitted_by         text REFERENCES users(id),
  approved_by          text REFERENCES users(id),
  approved_at          timestamptz,
  owner_approved_by    text REFERENCES users(id),
  owner_approved_at    timestamptz,
  rejected_reason      text,
  paid_by              text REFERENCES users(id),
  paid_date            date,
  paid_reference       text,
  bank_line_id         text,
  approve_journal_id   text REFERENCES journal_entries(id),
  pay_journal_id       text REFERENCES journal_entries(id),
  migrated             boolean NOT NULL DEFAULT false,
  created_at           timestamptz NOT NULL DEFAULT now(),
  source_system        text,
  source_record_id     text,
  mig_job_id           text REFERENCES mig_jobs(id),
  mig_batch_id         text REFERENCES mig_batches(id),
  UNIQUE (org_id, number),
  UNIQUE (org_id, source_system, source_record_id),
  CHECK ((source_system IS NULL) = (source_record_id IS NULL)),
  CHECK (recover_from = 'company' OR owner_id IS NOT NULL OR mig_job_id IS NOT NULL),
  CONSTRAINT bill_approved_by_second_person CHECK (approved_by IS NULL OR approved_by IS DISTINCT FROM submitted_by),
  CONSTRAINT bill_paid_by_third_person CHECK (paid_by IS NULL OR paid_by IS DISTINCT FROM approved_by)
);
CREATE UNIQUE INDEX pm_bills_supplier_invoice ON pm_bills (org_id, supplier_id, upper(btrim(supplier_invoice_no)))
  WHERE supplier_invoice_no IS NOT NULL AND status <> 'rejected';

CREATE FUNCTION pm_bills_migrated() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.mig_job_id IS NOT NULL THEN
    NEW.migrated := true;
    IF NEW.number IS NULL THEN
      NEW.number := 'OB-' || COALESCE(NEW.source_record_id, upper(right(NEW.id, 10)));
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER pm_bills_migrated BEFORE INSERT ON pm_bills
  FOR EACH ROW EXECUTE FUNCTION pm_bills_migrated();

-- owner payouts: prepared by one person, approved by a second, released (bank file) by someone other than the approver
CREATE TABLE pm_payouts (
  id             text PRIMARY KEY,
  org_id         text NOT NULL REFERENCES organisations(id),
  number         text NOT NULL,
  owner_id       text NOT NULL REFERENCES contacts(id),
  amount_minor   bigint NOT NULL CHECK (amount_minor > 0),
  balance_minor  bigint NOT NULL,
  reserve_minor  bigint NOT NULL,
  as_of          date NOT NULL,
  status         text NOT NULL CHECK (status IN ('prepared', 'approved', 'released', 'paid', 'cancelled')),
  prepared_by    text NOT NULL REFERENCES users(id),
  approved_by    text REFERENCES users(id),
  released_by    text REFERENCES users(id),
  release_date   date,
  bank_line_id   text,
  journal_id     text REFERENCES journal_entries(id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, number),
  CONSTRAINT payout_approved_by_second_person CHECK (approved_by IS NULL OR approved_by <> prepared_by),
  CONSTRAINT payout_released_by_other_than_approver CHECK (released_by IS NULL OR released_by <> approved_by)
);
CREATE UNIQUE INDEX pm_payouts_one_open ON pm_payouts (owner_id) WHERE status IN ('prepared', 'approved');

-- which property / owner / tenant / lease a PM posting belongs to (one row per journal)
CREATE TABLE pm_ledger_links (
  journal_id   text PRIMARY KEY REFERENCES journal_entries(id),
  org_id       text NOT NULL,
  kind         text NOT NULL CHECK (kind IN ('invoice', 'receipt', 'collection', 'credit_note', 'deposit_refund',
                 'bill', 'bill_payment', 'payout')),
  property_id  text REFERENCES pm_properties(id),
  owner_id     text REFERENCES contacts(id),
  tenant_id    text REFERENCES contacts(id),
  lease_id     text REFERENCES pm_leases(id),
  ref_id       text NOT NULL
);
CREATE INDEX pm_ledger_links_owner ON pm_ledger_links (owner_id) WHERE owner_id IS NOT NULL;
CREATE INDEX pm_ledger_links_tenant ON pm_ledger_links (tenant_id) WHERE tenant_id IS NOT NULL;

-- ============================================================== bank reconciliation of recorded money

CREATE TABLE pm_bank_lines (
  id            text PRIMARY KEY,
  org_id        text NOT NULL REFERENCES organisations(id),
  account_code  text NOT NULL,
  date          date NOT NULL,
  -- positive = money in, negative = money out
  amount_minor  bigint NOT NULL CHECK (amount_minor <> 0),
  reference     text NOT NULL,
  description   text NOT NULL DEFAULT '',
  statement     text NOT NULL DEFAULT '',
  status        text NOT NULL CHECK (status IN ('unmatched', 'matched', 'ignored')),
  matched_kind  text CHECK (matched_kind IN ('payment', 'payout', 'bill_payment', 'deposit_refund')),
  matched_id    text,
  decided_by    text REFERENCES users(id),
  decided_at    timestamptz,
  note          text NOT NULL DEFAULT '',
  imported_by   text NOT NULL REFERENCES users(id),
  imported_at   timestamptz NOT NULL DEFAULT now(),
  CHECK ((status = 'matched') = (matched_id IS NOT NULL))
);
CREATE UNIQUE INDEX pm_bank_lines_once ON pm_bank_lines (org_id, account_code, date, amount_minor, upper(btrim(reference)));
CREATE UNIQUE INDEX pm_bank_lines_match_once ON pm_bank_lines (matched_kind, matched_id) WHERE matched_id IS NOT NULL;

CREATE TABLE pm_reconciliations (
  id                        text PRIMARY KEY,
  org_id                    text NOT NULL REFERENCES organisations(id),
  account_code              text NOT NULL,
  statement_date            date NOT NULL,
  statement_balance_minor   bigint NOT NULL,
  ledger_balance_minor      bigint NOT NULL,
  uncleared_in_minor        bigint NOT NULL,
  uncleared_out_minor       bigint NOT NULL,
  unmatched_lines_minor     bigint NOT NULL,
  difference_minor          bigint NOT NULL,
  status                    text NOT NULL CHECK (status IN ('prepared', 'approved')),
  prepared_by               text NOT NULL REFERENCES users(id),
  prepared_at               timestamptz NOT NULL DEFAULT now(),
  approved_by               text REFERENCES users(id),
  approved_at               timestamptz,
  CONSTRAINT reconciliation_second_person CHECK (approved_by IS NULL OR approved_by <> prepared_by)
);

-- ============================================================== CRM pipeline (on the one contact store)

CREATE TABLE pm_leads (
  id                 text PRIMARY KEY,
  org_id             text NOT NULL REFERENCES organisations(id),
  number             text NOT NULL,
  contact_id         text NOT NULL REFERENCES contacts(id),
  source             text NOT NULL,
  campaign           text,
  unit_id            text REFERENCES pm_units(id),
  budget_minor       bigint CHECK (budget_minor >= 0),
  bedrooms           integer CHECK (bedrooms BETWEEN 0 AND 50),
  move_in            date,
  stage              text NOT NULL CHECK (stage IN ('new', 'contacted', 'qualified', 'viewing', 'viewed', 'application',
                       'approved', 'won', 'lost')),
  stage_at           timestamptz NOT NULL DEFAULT now(),
  agent_id           text REFERENCES users(id),
  lost_reason        text,
  lost_note          text,
  idempotency_key    text,
  first_response_at  timestamptz,
  created_by         text REFERENCES users(id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, number),
  CHECK (stage <> 'lost' OR lost_reason IS NOT NULL)
);
CREATE UNIQUE INDEX pm_leads_key ON pm_leads (org_id, idempotency_key) WHERE idempotency_key IS NOT NULL;

CREATE TABLE pm_viewings (
  id           text PRIMARY KEY,
  org_id       text NOT NULL REFERENCES organisations(id),
  lead_id      text NOT NULL REFERENCES pm_leads(id),
  contact_id   text NOT NULL REFERENCES contacts(id),
  unit_id      text NOT NULL REFERENCES pm_units(id),
  agent_id     text NOT NULL REFERENCES users(id),
  date         date NOT NULL,
  time         text NOT NULL CHECK (time ~ '^([01]\d|2[0-3]):[0-5]\d$'),
  status       text NOT NULL CHECK (status IN ('scheduled', 'completed', 'no_show', 'cancelled')),
  feedback     text NOT NULL DEFAULT '',
  interest     integer CHECK (interest BETWEEN 1 AND 5),
  created_by   text NOT NULL REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE pm_applications (
  id                   text PRIMARY KEY,
  org_id               text NOT NULL REFERENCES organisations(id),
  number               text NOT NULL,
  lead_id              text NOT NULL REFERENCES pm_leads(id),
  contact_id           text NOT NULL REFERENCES contacts(id),
  unit_id              text NOT NULL REFERENCES pm_units(id),
  status               text NOT NULL CHECK (status IN ('submitted', 'screening', 'approved', 'rejected', 'withdrawn',
                         'converted')),
  employer             text NOT NULL DEFAULT '',
  income_minor         bigint CHECK (income_minor >= 0),
  occupants            integer NOT NULL DEFAULT 1 CHECK (occupants BETWEEN 1 AND 50),
  offer_rent_minor     bigint NOT NULL CHECK (offer_rent_minor > 0),
  offer_deposit_minor  bigint NOT NULL CHECK (offer_deposit_minor >= 0),
  offer_start          date NOT NULL,
  offer_months         integer NOT NULL CHECK (offer_months BETWEEN 1 AND 120),
  check_identity       boolean NOT NULL DEFAULT false,
  check_income         boolean NOT NULL DEFAULT false,
  check_reference      boolean NOT NULL DEFAULT false,
  screened_by          text REFERENCES users(id),
  approved_by          text REFERENCES users(id),
  decision_note        text,
  lease_id             text REFERENCES pm_leases(id),
  created_by           text NOT NULL REFERENCES users(id),
  created_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, number),
  CONSTRAINT application_approved_by_second_person CHECK (approved_by IS NULL OR approved_by IS DISTINCT FROM screened_by)
);

-- ============================================================== notices and documents

CREATE TABLE pm_notices (
  id            text PRIMARY KEY,
  org_id        text NOT NULL REFERENCES organisations(id),
  property_id   text NOT NULL REFERENCES pm_properties(id),
  title         text NOT NULL,
  body          text NOT NULL,
  channel       text NOT NULL CHECK (channel IN ('email', 'sms', 'whatsapp', 'inapp')),
  recipients    integer NOT NULL,
  recorded      integer NOT NULL,
  blocked       integer NOT NULL,
  published_by  text NOT NULL REFERENCES users(id),
  published_at  timestamptz NOT NULL DEFAULT now()
);

-- document records (metadata). Files brought by a data migration keep their bytes in mig_files (file_id).
CREATE TABLE pm_documents (
  id                text PRIMARY KEY,
  org_id            text NOT NULL REFERENCES organisations(id),
  name              text,
  doc_type          text NOT NULL DEFAULT 'other',
  link_entity       text,
  link_id           text,
  filename          text NOT NULL,
  size_bytes        bigint CHECK (size_bytes >= 0),
  sha256            text,
  detected_type     text,
  original_ref      text,
  file_id           text REFERENCES mig_files(id),
  visibility        text NOT NULL DEFAULT 'staff' CHECK (visibility IN ('staff', 'tenant', 'owner')),
  uploaded_by       text REFERENCES users(id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  source_system     text,
  source_record_id  text,
  mig_job_id        text REFERENCES mig_jobs(id),
  mig_batch_id      text REFERENCES mig_batches(id),
  UNIQUE (org_id, source_system, source_record_id),
  CHECK ((source_system IS NULL) = (source_record_id IS NULL))
);
CREATE INDEX pm_documents_link ON pm_documents (org_id, link_entity, link_id);

-- ============================================================== data migration: built-in source profile for Property Management
-- (data, not code: organisations copy and adjust it). Column names of a typical accounting-software export.
INSERT INTO mig_profiles (id, org_id, domain, name, description, config) VALUES
('mpf_pm_accounting_export', NULL, 'property', 'Accounting software export (QuickBooks-style)',
 'Account list, customer and vendor contact lists, recurring rent templates, open invoices, the tenant deposits report, unpaid bills and the trial balance. ISO dates, point decimals, comma thousands.',
 '{"settings":{"dateFormat":"YYYY-MM-DD","decimalSeparator":".","thousandsSeparator":","},
   "entityHints":{"account":["account list"],"tenant":["customer contact list"],"vendor":["vendor contact list"],
                  "lease":["recurring template list"],"opening_invoice":["open invoices"],
                  "deposit":["tenant security deposits","deposits quickreport"],"bill":["unpaid bills"],"trial_balance":["trial balance"]},
   "aliases":{"account":{"source_record_id":["account"]},
              "tenant":{"source_record_id":["customer"],"name":["full name"],"phone":["phone numbers"],"address":["billing address"]},
              "vendor":{"source_record_id":["vendor"],"phone":["phone numbers"],"tax_id":["tax id"]},
              "lease":{"source_record_id":["template name"],"tenant_ref":["customer"],"rent":["amount"]},
              "opening_invoice":{"source_record_id":["num"],"tenant_ref":["customer"],"issue_date":["date"],"amount":["open balance"]},
              "deposit":{"source_record_id":["customer"]},
              "bill":{"source_record_id":["num"],"supplier_ref":["vendor"],"bill_date":["date"],"amount":["open balance"],"description":["memo"]},
              "trial_balance":{"source_record_id":["account"]}},
   "enums":{}}');
