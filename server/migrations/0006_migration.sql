-- Data migration: move a customer's records from another system (spreadsheets, other software exports) into PALTAS.
--
-- Two parts:
--   mig_*  the shared, domain-agnostic migration engine (any product registers a "domain" with it);
--   dev_*  Real Estate Development records, the first full target domain.
--
-- Rules the database itself keeps:
--   * every migrated record carries source_system + source_record_id, unique per organisation (and per kind for the
--     shared contact and supplier lists), so running the same import again can never create a record twice;
--   * the person who ran the dry run, or who changed a mapping, a row or a document decision, cannot be the person
--     who approves the import; the person who approved it cannot sign it off (separation of duties);
--   * every change to what would be imported bumps the job's revision; the dry run records the revision it saw, so
--     an approval or import of a dry run that no longer matches the data is refused;
--   * uploaded bytes live in PostgreSQL (bytea) with their SHA-256; refused uploads keep no content;
--   * a migrated record points at the batch that created it, so a batch can be undone without touching anything
--     that existed before it (foreign keys stop a rollback that would orphan later records).

-- ============================================================== engine

-- Source-system profiles: how a given export looks (sheet names, column aliases, date and number formats).
-- org_id NULL = a built-in profile offered to every organisation; organisations save their own copies.
CREATE TABLE mig_profiles (
  id           text PRIMARY KEY,
  org_id       text REFERENCES organisations(id),
  domain       text NOT NULL,
  name         text NOT NULL,
  description  text NOT NULL DEFAULT '',
  -- { settings: {dateFormat, decimalSeparator, thousandsSeparator}, entityHints: {entity: [keywords]},
  --   aliases: {entity: {field: [source column names]}}, enums: {"entity.field": {source value: PALTAS value}} }
  config       jsonb NOT NULL,
  created_by   text REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX mig_profiles_name ON mig_profiles (COALESCE(org_id, ''), domain, lower(name));

CREATE TABLE mig_jobs (
  id               text PRIMARY KEY,
  org_id           text NOT NULL REFERENCES organisations(id),
  number           text NOT NULL,
  domain           text NOT NULL,
  name             text NOT NULL,
  source_system    text NOT NULL CHECK (source_system ~ '^[a-z0-9][a-z0-9._-]{1,59}$'),
  profile_id       text REFERENCES mig_profiles(id),
  cutover_date     date NOT NULL,
  currency         char(3) NOT NULL,
  settings         jsonb NOT NULL DEFAULT '{}',
  -- source selected → files uploaded → detected → mapped → validated → resolved → dry run → approved → importing
  -- → reconciled → completed; failed (a batch failed: retry it or roll back), rolled_back
  status           text NOT NULL CHECK (status IN ('created', 'uploaded', 'detected', 'mapped', 'validated', 'resolved',
                     'dry_run', 'approved', 'importing', 'reconciled', 'completed', 'failed', 'rolled_back')),
  created_by       text NOT NULL REFERENCES users(id),
  validation       jsonb,
  dry_run          jsonb,
  dry_run_by       text REFERENCES users(id),
  dry_run_at       timestamptz,
  approved_by      text REFERENCES users(id),
  approved_at      timestamptz,
  reconciliation   jsonb,
  completed_by     text REFERENCES users(id),
  completed_at     timestamptz,
  last_error       text,
  -- bumped by every change to files, tables, mappings, rows or document decisions; dry_run_revision is the
  -- revision the dry run saw (approval and import refuse when they differ)
  revision         bigint NOT NULL DEFAULT 0,
  dry_run_revision bigint,
  -- everyone who changed a mapping, a row or a document decision of this job
  changed_by       text[] NOT NULL DEFAULT '{}',
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, number),
  CONSTRAINT migration_approved_by_second_person CHECK (approved_by IS NULL OR approved_by IS DISTINCT FROM dry_run_by),
  CONSTRAINT migration_approver_changed_nothing CHECK (approved_by IS NULL OR NOT (approved_by = ANY (changed_by))),
  CONSTRAINT migration_signed_off_by_another CHECK (completed_by IS NULL OR completed_by IS DISTINCT FROM approved_by)
);
CREATE INDEX mig_jobs_org ON mig_jobs (org_id, created_at DESC);

-- Uploaded files, and the files found inside an uploaded ZIP (parent_id). Bytes arrive in chunks (mig_upload_chunks),
-- are checked (size, SHA-256, magic bytes, archive safety) and only then kept in `content`.
CREATE TABLE mig_files (
  id               text PRIMARY KEY,
  org_id           text NOT NULL REFERENCES organisations(id),
  job_id           text NOT NULL REFERENCES mig_jobs(id),
  parent_id        text REFERENCES mig_files(id),
  filename         text NOT NULL,
  -- the path inside the archive for extracted files
  original_ref     text NOT NULL,
  declared_size    bigint NOT NULL CHECK (declared_size >= 0),
  declared_sha256  text,
  size_bytes       bigint,
  sha256           text,
  detected_type    text,
  status           text NOT NULL CHECK (status IN ('uploading', 'stored', 'refused')),
  refusal          text,
  content          bytea,
  uploaded_by      text NOT NULL REFERENCES users(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  CHECK (status <> 'refused' OR (refusal IS NOT NULL AND content IS NULL)),
  -- a stored ZIP keeps no bytes of its own: its entries are stored as files of their own
  CHECK (status <> 'stored' OR (sha256 IS NOT NULL AND (content IS NOT NULL OR detected_type = 'zip')))
);
CREATE INDEX mig_files_job ON mig_files (job_id);

CREATE TABLE mig_upload_chunks (
  file_id  text NOT NULL REFERENCES mig_files(id) ON DELETE CASCADE,
  idx      integer NOT NULL CHECK (idx >= 0),
  data     bytea NOT NULL,
  PRIMARY KEY (file_id, idx)
);

-- One table per CSV file, spreadsheet sheet or JSON array, with its mapping to a domain entity.
CREATE TABLE mig_tables (
  id          text PRIMARY KEY,
  org_id      text NOT NULL REFERENCES organisations(id),
  job_id      text NOT NULL REFERENCES mig_jobs(id),
  file_id     text NOT NULL REFERENCES mig_files(id),
  name        text NOT NULL,
  headers     jsonb NOT NULL,
  row_count   integer NOT NULL,
  -- the guessed (then confirmed) entity; NULL = not imported (must be confirmed as ignored)
  entity      text,
  confidence  numeric(4, 2) NOT NULL DEFAULT 0,
  ignored     boolean NOT NULL DEFAULT false,
  ignore_reason text,
  -- [{ source, field, transforms: [...] }]
  mapping     jsonb NOT NULL DEFAULT '[]',
  -- who last confirmed the mapping (or ignored the table)
  mapped_by   text REFERENCES users(id),
  sample      jsonb NOT NULL DEFAULT '[]',
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX mig_tables_job ON mig_tables (job_id);

CREATE TABLE mig_rows (
  id                 bigserial PRIMARY KEY,
  org_id             text NOT NULL REFERENCES organisations(id),
  job_id             text NOT NULL REFERENCES mig_jobs(id),
  table_id           text NOT NULL REFERENCES mig_tables(id) ON DELETE CASCADE,
  row_no             integer NOT NULL,
  raw                jsonb NOT NULL,
  entity             text,
  source_record_id   text,
  -- mapped, transformed values (and resolved references) from the last validation
  data               jsonb,
  -- per-row corrections made while resolving: { field: value } in source form
  correction         jsonb NOT NULL DEFAULT '{}',
  -- explicit decisions: skip (with reason), merge into another row or an existing record, keep a flagged duplicate
  decision           text CHECK (decision IN ('skip', 'merge', 'keep')),
  decision_reason    text,
  merge_into_row     bigint REFERENCES mig_rows(id),
  merge_into_target  text,
  decided_by         text REFERENCES users(id),
  status             text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'valid', 'error', 'skipped', 'merged',
                       'already_present', 'imported')),
  batch_id           text,
  target_id          text,
  UNIQUE (table_id, row_no),
  CHECK (decision IS NULL OR decision_reason IS NOT NULL),
  CHECK (decision IS DISTINCT FROM 'merge' OR merge_into_row IS NOT NULL OR merge_into_target IS NOT NULL)
);
CREATE INDEX mig_rows_job ON mig_rows (job_id, entity);
CREATE INDEX mig_rows_batch ON mig_rows (batch_id);

-- Problems found by validation (rewritten on every validation run).
CREATE TABLE mig_issues (
  id           bigserial PRIMARY KEY,
  org_id       text NOT NULL REFERENCES organisations(id),
  job_id       text NOT NULL REFERENCES mig_jobs(id),
  row_id       bigint REFERENCES mig_rows(id) ON DELETE CASCADE,
  document_id  text,
  entity       text,
  field        text,
  severity     text NOT NULL CHECK (severity IN ('error', 'warning')),
  code         text NOT NULL,
  message      text NOT NULL
);
CREATE INDEX mig_issues_job ON mig_issues (job_id, severity);

-- The import runs as batches in a background worker. A worker holds a lease on the batch it runs and renews it
-- (heartbeat); a batch whose lease ran out (the server stopped) is picked up again. Each batch runs in one
-- transaction, so a stopped batch leaves nothing half-written.
CREATE TABLE mig_batches (
  id                   text PRIMARY KEY,
  org_id               text NOT NULL REFERENCES organisations(id),
  job_id               text NOT NULL REFERENCES mig_jobs(id),
  seq                  integer NOT NULL,
  entity               text NOT NULL,
  row_count            integer NOT NULL,
  status               text NOT NULL CHECK (status IN ('queued', 'running', 'done', 'failed', 'rolled_back')),
  attempts             integer NOT NULL DEFAULT 0,
  lease_owner          text,
  lease_until          timestamptz,
  heartbeat_at         timestamptz,
  error                text,
  created_count        integer NOT NULL DEFAULT 0,
  present_count        integer NOT NULL DEFAULT 0,
  journal_id           text REFERENCES journal_entries(id),
  reversal_journal_id  text REFERENCES journal_entries(id),
  started_at           timestamptz,
  finished_at          timestamptz,
  rolled_back_by       text REFERENCES users(id),
  rolled_back_at       timestamptz,
  rollback_reason      text,
  queued_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (job_id, seq),
  CHECK (status <> 'running' OR (lease_owner IS NOT NULL AND lease_until IS NOT NULL))
);
CREATE INDEX mig_batches_queue ON mig_batches (status, queued_at);

-- Files that are documents (PDFs, images, from a ZIP or uploaded alone) waiting to become document records.
-- A document links itself only when exactly one record matches; otherwise it waits in the review queue.
CREATE TABLE mig_documents (
  id              text PRIMARY KEY,
  org_id          text NOT NULL REFERENCES organisations(id),
  job_id          text NOT NULL REFERENCES mig_jobs(id),
  file_id         text NOT NULL REFERENCES mig_files(id),
  filename        text NOT NULL,
  original_ref    text NOT NULL,
  size_bytes      bigint NOT NULL,
  sha256          text NOT NULL,
  detected_type   text NOT NULL,
  -- linked: will attach to one record; review: needs a person; unlinked: kept without a link (decided);
  -- excluded: not imported (decided, with reason); unsupported / corrupt: reported, never imported
  status          text NOT NULL CHECK (status IN ('linked', 'review', 'unlinked', 'excluded', 'unsupported', 'corrupt')),
  link_mode       text CHECK (link_mode IN ('auto', 'manual')),
  link_entity     text,
  link_source_id  text,
  link_target_id  text,
  reason          text NOT NULL DEFAULT '',
  candidates      jsonb NOT NULL DEFAULT '[]',
  decided_by      text REFERENCES users(id),
  batch_id        text REFERENCES mig_batches(id),
  target_id       text,
  UNIQUE (job_id, file_id)
);

-- built-in source-system profiles for the Development domain (data, not code: organisations copy and adjust them)
INSERT INTO mig_profiles (id, org_id, domain, name, description, config) VALUES
('mpf_generic_spreadsheet', NULL, 'development', 'Generic spreadsheet',
 'One sheet or CSV per kind of record, with column names close to the PALTAS field names. ISO dates, point decimals.',
 '{"settings":{"dateFormat":"YYYY-MM-DD","decimalSeparator":".","thousandsSeparator":","},"entityHints":{},"aliases":{},"enums":{}}'),
('mpf_accounting_csv', NULL, 'development', 'Accounting software CSV export',
 'Customer, supplier, invoice-schedule and receipt exports from accounting software. Day-first dates, point decimals.',
 '{"settings":{"dateFormat":"DD/MM/YYYY","decimalSeparator":".","thousandsSeparator":","},
   "entityHints":{"buyer":["customer list","customers"],"supplier":["vendor list","vendors"],"payment":["receipts","payments received","sales receipts"],"instalment":["payment schedule","invoice schedule"],"opening_balance":["opening balances","trial balance detail"]},
   "aliases":{"buyer":{"source_record_id":["customer id","customer ref","customer no"],"name":["customer","customer name","display name"],"phone":["phone numbers","mobile"],"national_id":["tax id","id number","pin"]},
              "supplier":{"source_record_id":["vendor id","vendor ref"],"name":["vendor","vendor name"],"tax_id":["tax id","kra pin","vat number"]},
              "payment":{"source_record_id":["receipt no","receipt number","num"],"date":["receipt date","date"],"amount":["amount received","total"],"reference":["memo","ref no"],"method":["payment method"]},
              "instalment":{"source_record_id":["invoice no","schedule line"],"due_date":["due date"],"amount":["invoice amount","amount"]}},
   "enums":{"payment.kind":{"payment":"receipt","sales receipt":"receipt","refund receipt":"refund","credit refund":"refund"},"payment.method":{}}}'),
('mpf_crm_contacts', NULL, 'development', 'CRM contacts CSV',
 'Leads and customers exported from a CRM: one row per person, with email and phone.',
 '{"settings":{"dateFormat":"YYYY-MM-DD","decimalSeparator":".","thousandsSeparator":","},
   "entityHints":{"buyer":["contacts","leads","customers","people"],"investor":["investors"]},
   "aliases":{"buyer":{"source_record_id":["contact id","record id","lead id"],"name":["full name","contact name"],"email":["email address","e-mail","primary email"],"phone":["mobile phone","phone number","primary phone"],"national_id":["id/passport","passport no","national id no"]}},
   "enums":{"buyer.party_type":{"person":"individual","individual":"individual","organisation":"company","organization":"company","company":"company"}}}'),
('mpf_project_management', NULL, 'development', 'Project management export',
 'Projects, phases, milestones, contractors and work orders from a project management or construction tool.',
 '{"settings":{"dateFormat":"YYYY-MM-DD","decimalSeparator":".","thousandsSeparator":","},
   "entityHints":{"milestone":["milestones","tasks","schedule"],"work_order":["work orders","jobs","tickets"],"contractor":["contractors","subcontractors"],"phase":["phases","stages"]},
   "aliases":{"milestone":{"name":["task name","milestone name"],"due_date":["finish","planned finish","due"],"completed_date":["actual finish"],"percent":["% complete","percent complete","progress"]},
              "work_order":{"number":["wo number","job no"],"description":["scope","summary"]}},
   "enums":{"milestone.status":{"not started":"planned","in progress":"in_progress","complete":"completed","done":"completed"}}}');

-- ============================================================== Real Estate Development target records
-- Every table: id, org_id, the source key, the migration job and batch that created it (NULL for records made
-- in PALTAS itself), and its own columns. Money is integer minor units in the organisation's currency.

CREATE TABLE dev_projects (
  id                text PRIMARY KEY,
  org_id            text NOT NULL REFERENCES organisations(id),
  source_system     text,
  source_record_id  text,
  mig_job_id        text REFERENCES mig_jobs(id),
  mig_batch_id      text REFERENCES mig_batches(id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  name              text NOT NULL,
  code              text,
  location          text,
  status            text CHECK (status IN ('planning', 'construction', 'selling', 'completed')),
  start_date        date,
  end_date          date,
  UNIQUE (org_id, source_system, source_record_id),
  CHECK ((source_system IS NULL) = (source_record_id IS NULL))
);

CREATE TABLE dev_phases (
  id text PRIMARY KEY, org_id text NOT NULL REFERENCES organisations(id), source_system text, source_record_id text,
  mig_job_id text REFERENCES mig_jobs(id), mig_batch_id text REFERENCES mig_batches(id), created_at timestamptz NOT NULL DEFAULT now(),
  project_id  text NOT NULL REFERENCES dev_projects(id),
  name        text NOT NULL,
  start_date  date,
  end_date    date,
  UNIQUE (org_id, source_system, source_record_id), CHECK ((source_system IS NULL) = (source_record_id IS NULL))
);

CREATE TABLE dev_buildings (
  id text PRIMARY KEY, org_id text NOT NULL REFERENCES organisations(id), source_system text, source_record_id text,
  mig_job_id text REFERENCES mig_jobs(id), mig_batch_id text REFERENCES mig_batches(id), created_at timestamptz NOT NULL DEFAULT now(),
  project_id    text NOT NULL REFERENCES dev_projects(id),
  phase_id      text REFERENCES dev_phases(id),
  name          text NOT NULL,
  floors_count  integer,
  UNIQUE (org_id, source_system, source_record_id), CHECK ((source_system IS NULL) = (source_record_id IS NULL))
);

CREATE TABLE dev_floors (
  id text PRIMARY KEY, org_id text NOT NULL REFERENCES organisations(id), source_system text, source_record_id text,
  mig_job_id text REFERENCES mig_jobs(id), mig_batch_id text REFERENCES mig_batches(id), created_at timestamptz NOT NULL DEFAULT now(),
  building_id  text NOT NULL REFERENCES dev_buildings(id),
  level        integer NOT NULL,
  name         text,
  UNIQUE (org_id, source_system, source_record_id), CHECK ((source_system IS NULL) = (source_record_id IS NULL))
);

CREATE TABLE dev_units (
  id text PRIMARY KEY, org_id text NOT NULL REFERENCES organisations(id), source_system text, source_record_id text,
  mig_job_id text REFERENCES mig_jobs(id), mig_batch_id text REFERENCES mig_batches(id), created_at timestamptz NOT NULL DEFAULT now(),
  project_id        text NOT NULL REFERENCES dev_projects(id),
  building_id       text REFERENCES dev_buildings(id),
  floor_id          text REFERENCES dev_floors(id),
  unit_no           text NOT NULL,
  type              text,
  bedrooms          integer,
  area_sqm          numeric(12, 2),
  list_price_minor  bigint CHECK (list_price_minor >= 0),
  status            text CHECK (status IN ('available', 'reserved', 'sold', 'handed_over', 'blocked')),
  UNIQUE (org_id, source_system, source_record_id), CHECK ((source_system IS NULL) = (source_record_id IS NULL))
);

-- the ONE Development contact list: buyers and investors (kind)
CREATE TABLE dev_contacts (
  id text PRIMARY KEY, org_id text NOT NULL REFERENCES organisations(id), source_system text, source_record_id text,
  mig_job_id text REFERENCES mig_jobs(id), mig_batch_id text REFERENCES mig_batches(id), created_at timestamptz NOT NULL DEFAULT now(),
  kind              text NOT NULL CHECK (kind IN ('buyer', 'investor')),
  name              text NOT NULL,
  email             text,
  phone             text,
  national_id       text,
  party_type        text CHECK (party_type IN ('individual', 'company')),
  address           text,
  project_id        text REFERENCES dev_projects(id),
  committed_minor   bigint CHECK (committed_minor >= 0),
  UNIQUE (org_id, kind, source_system, source_record_id), CHECK ((source_system IS NULL) = (source_record_id IS NULL))
);
CREATE INDEX dev_contacts_email ON dev_contacts (org_id, lower(email));
CREATE INDEX dev_contacts_phone ON dev_contacts (org_id, phone);

CREATE TABLE dev_reservations (
  id text PRIMARY KEY, org_id text NOT NULL REFERENCES organisations(id), source_system text, source_record_id text,
  mig_job_id text REFERENCES mig_jobs(id), mig_batch_id text REFERENCES mig_batches(id), created_at timestamptz NOT NULL DEFAULT now(),
  unit_id        text NOT NULL REFERENCES dev_units(id),
  buyer_id       text NOT NULL REFERENCES dev_contacts(id),
  date           date NOT NULL,
  deposit_minor  bigint CHECK (deposit_minor >= 0),
  expiry_date    date,
  status         text CHECK (status IN ('active', 'converted', 'cancelled', 'expired')),
  UNIQUE (org_id, source_system, source_record_id), CHECK ((source_system IS NULL) = (source_record_id IS NULL))
);

CREATE TABLE dev_contracts (
  id text PRIMARY KEY, org_id text NOT NULL REFERENCES organisations(id), source_system text, source_record_id text,
  mig_job_id text REFERENCES mig_jobs(id), mig_batch_id text REFERENCES mig_batches(id), created_at timestamptz NOT NULL DEFAULT now(),
  unit_id                text NOT NULL REFERENCES dev_units(id),
  buyer_id               text NOT NULL REFERENCES dev_contacts(id),
  reservation_id         text REFERENCES dev_reservations(id),
  number                 text,
  date                   date NOT NULL,
  price_minor            bigint NOT NULL CHECK (price_minor > 0),
  reported_balance_minor bigint,
  status                 text CHECK (status IN ('active', 'completed', 'cancelled')),
  UNIQUE (org_id, source_system, source_record_id), CHECK ((source_system IS NULL) = (source_record_id IS NULL))
);

CREATE TABLE dev_contract_amendments (
  id text PRIMARY KEY, org_id text NOT NULL REFERENCES organisations(id), source_system text, source_record_id text,
  mig_job_id text REFERENCES mig_jobs(id), mig_batch_id text REFERENCES mig_batches(id), created_at timestamptz NOT NULL DEFAULT now(),
  contract_id         text NOT NULL REFERENCES dev_contracts(id),
  date                date NOT NULL,
  description         text NOT NULL,
  price_change_minor  bigint,
  UNIQUE (org_id, source_system, source_record_id), CHECK ((source_system IS NULL) = (source_record_id IS NULL))
);

CREATE TABLE dev_instalments (
  id text PRIMARY KEY, org_id text NOT NULL REFERENCES organisations(id), source_system text, source_record_id text,
  mig_job_id text REFERENCES mig_jobs(id), mig_batch_id text REFERENCES mig_batches(id), created_at timestamptz NOT NULL DEFAULT now(),
  contract_id   text NOT NULL REFERENCES dev_contracts(id),
  seq           integer NOT NULL,
  due_date      date NOT NULL,
  amount_minor  bigint NOT NULL CHECK (amount_minor > 0),
  description   text,
  UNIQUE (org_id, source_system, source_record_id), CHECK ((source_system IS NULL) = (source_record_id IS NULL))
);

-- receipts and refunds (kind); amounts are positive, a refund reduces what the buyer has paid
CREATE TABLE dev_payments (
  id text PRIMARY KEY, org_id text NOT NULL REFERENCES organisations(id), source_system text, source_record_id text,
  mig_job_id text REFERENCES mig_jobs(id), mig_batch_id text REFERENCES mig_batches(id), created_at timestamptz NOT NULL DEFAULT now(),
  contract_id   text NOT NULL REFERENCES dev_contracts(id),
  buyer_id      text REFERENCES dev_contacts(id),
  kind          text NOT NULL CHECK (kind IN ('receipt', 'refund')),
  date          date NOT NULL,
  amount_minor  bigint NOT NULL CHECK (amount_minor > 0),
  method        text,
  reference     text,
  UNIQUE (org_id, source_system, source_record_id), CHECK ((source_system IS NULL) = (source_record_id IS NULL))
);

CREATE TABLE dev_payment_allocations (
  id text PRIMARY KEY, org_id text NOT NULL REFERENCES organisations(id), source_system text, source_record_id text,
  mig_job_id text REFERENCES mig_jobs(id), mig_batch_id text REFERENCES mig_batches(id), created_at timestamptz NOT NULL DEFAULT now(),
  payment_id     text NOT NULL REFERENCES dev_payments(id),
  instalment_id  text NOT NULL REFERENCES dev_instalments(id),
  amount_minor   bigint NOT NULL CHECK (amount_minor > 0),
  UNIQUE (org_id, source_system, source_record_id), CHECK ((source_system IS NULL) = (source_record_id IS NULL))
);

CREATE TABLE dev_suppliers (
  id text PRIMARY KEY, org_id text NOT NULL REFERENCES organisations(id), source_system text, source_record_id text,
  mig_job_id text REFERENCES mig_jobs(id), mig_batch_id text REFERENCES mig_batches(id), created_at timestamptz NOT NULL DEFAULT now(),
  kind     text NOT NULL CHECK (kind IN ('supplier', 'contractor')),
  name     text NOT NULL,
  tax_id   text,
  email    text,
  phone    text,
  trade    text,
  UNIQUE (org_id, kind, source_system, source_record_id), CHECK ((source_system IS NULL) = (source_record_id IS NULL))
);

-- balances carried over at the cut-over date; posted to the ONE ledger (journal_id) through postSystemJournal
CREATE TABLE dev_opening_balances (
  id text PRIMARY KEY, org_id text NOT NULL REFERENCES organisations(id), source_system text, source_record_id text,
  mig_job_id text REFERENCES mig_jobs(id), mig_batch_id text REFERENCES mig_batches(id), created_at timestamptz NOT NULL DEFAULT now(),
  kind            text NOT NULL CHECK (kind IN ('buyer_receivable', 'buyer_deposit', 'supplier_payable')),
  contract_id     text REFERENCES dev_contracts(id),
  reservation_id  text REFERENCES dev_reservations(id),
  supplier_id     text REFERENCES dev_suppliers(id),
  as_of           date NOT NULL,
  amount_minor    bigint NOT NULL CHECK (amount_minor > 0),
  memo            text,
  UNIQUE (org_id, source_system, source_record_id), CHECK ((source_system IS NULL) = (source_record_id IS NULL))
);

CREATE TABLE dev_purchase_orders (
  id text PRIMARY KEY, org_id text NOT NULL REFERENCES organisations(id), source_system text, source_record_id text,
  mig_job_id text REFERENCES mig_jobs(id), mig_batch_id text REFERENCES mig_batches(id), created_at timestamptz NOT NULL DEFAULT now(),
  supplier_id   text NOT NULL REFERENCES dev_suppliers(id),
  project_id    text NOT NULL REFERENCES dev_projects(id),
  number        text,
  date          date NOT NULL,
  amount_minor  bigint NOT NULL CHECK (amount_minor >= 0),
  status        text CHECK (status IN ('open', 'received', 'closed', 'cancelled')),
  description   text,
  UNIQUE (org_id, source_system, source_record_id), CHECK ((source_system IS NULL) = (source_record_id IS NULL))
);

CREATE TABLE dev_work_orders (
  id text PRIMARY KEY, org_id text NOT NULL REFERENCES organisations(id), source_system text, source_record_id text,
  mig_job_id text REFERENCES mig_jobs(id), mig_batch_id text REFERENCES mig_batches(id), created_at timestamptz NOT NULL DEFAULT now(),
  contractor_id  text NOT NULL REFERENCES dev_suppliers(id),
  project_id     text NOT NULL REFERENCES dev_projects(id),
  unit_id        text REFERENCES dev_units(id),
  number         text,
  date           date NOT NULL,
  amount_minor   bigint CHECK (amount_minor >= 0),
  description    text NOT NULL,
  status         text CHECK (status IN ('open', 'in_progress', 'done', 'cancelled')),
  UNIQUE (org_id, source_system, source_record_id), CHECK ((source_system IS NULL) = (source_record_id IS NULL))
);

CREATE TABLE dev_milestones (
  id text PRIMARY KEY, org_id text NOT NULL REFERENCES organisations(id), source_system text, source_record_id text,
  mig_job_id text REFERENCES mig_jobs(id), mig_batch_id text REFERENCES mig_batches(id), created_at timestamptz NOT NULL DEFAULT now(),
  project_id      text NOT NULL REFERENCES dev_projects(id),
  phase_id        text REFERENCES dev_phases(id),
  name            text NOT NULL,
  due_date        date,
  completed_date  date,
  percent         integer CHECK (percent BETWEEN 0 AND 100),
  status          text CHECK (status IN ('planned', 'in_progress', 'completed')),
  UNIQUE (org_id, source_system, source_record_id), CHECK ((source_system IS NULL) = (source_record_id IS NULL))
);

CREATE TABLE dev_handovers (
  id text PRIMARY KEY, org_id text NOT NULL REFERENCES organisations(id), source_system text, source_record_id text,
  mig_job_id text REFERENCES mig_jobs(id), mig_batch_id text REFERENCES mig_batches(id), created_at timestamptz NOT NULL DEFAULT now(),
  unit_id      text NOT NULL REFERENCES dev_units(id),
  contract_id  text REFERENCES dev_contracts(id),
  date         date NOT NULL,
  status       text CHECK (status IN ('scheduled', 'completed')),
  notes        text,
  UNIQUE (org_id, source_system, source_record_id), CHECK ((source_system IS NULL) = (source_record_id IS NULL))
);

CREATE TABLE dev_defects (
  id text PRIMARY KEY, org_id text NOT NULL REFERENCES organisations(id), source_system text, source_record_id text,
  mig_job_id text REFERENCES mig_jobs(id), mig_batch_id text REFERENCES mig_batches(id), created_at timestamptz NOT NULL DEFAULT now(),
  unit_id        text NOT NULL REFERENCES dev_units(id),
  handover_id    text REFERENCES dev_handovers(id),
  contractor_id  text REFERENCES dev_suppliers(id),
  reported_date  date NOT NULL,
  description    text NOT NULL,
  status         text CHECK (status IN ('open', 'fixed', 'closed')),
  UNIQUE (org_id, source_system, source_record_id), CHECK ((source_system IS NULL) = (source_record_id IS NULL))
);

CREATE TABLE dev_disputes (
  id text PRIMARY KEY, org_id text NOT NULL REFERENCES organisations(id), source_system text, source_record_id text,
  mig_job_id text REFERENCES mig_jobs(id), mig_batch_id text REFERENCES mig_batches(id), created_at timestamptz NOT NULL DEFAULT now(),
  buyer_id      text NOT NULL REFERENCES dev_contacts(id),
  contract_id   text REFERENCES dev_contracts(id),
  opened_date   date NOT NULL,
  subject       text NOT NULL,
  status        text CHECK (status IN ('open', 'resolved', 'closed')),
  amount_minor  bigint CHECK (amount_minor >= 0),
  UNIQUE (org_id, source_system, source_record_id), CHECK ((source_system IS NULL) = (source_record_id IS NULL))
);

CREATE TABLE dev_correspondence (
  id text PRIMARY KEY, org_id text NOT NULL REFERENCES organisations(id), source_system text, source_record_id text,
  mig_job_id text REFERENCES mig_jobs(id), mig_batch_id text REFERENCES mig_batches(id), created_at timestamptz NOT NULL DEFAULT now(),
  buyer_id     text REFERENCES dev_contacts(id),
  contract_id  text REFERENCES dev_contracts(id),
  dispute_id   text REFERENCES dev_disputes(id),
  date         date NOT NULL,
  channel      text CHECK (channel IN ('email', 'letter', 'call', 'meeting', 'sms', 'whatsapp', 'other')),
  subject      text NOT NULL,
  summary      text,
  UNIQUE (org_id, source_system, source_record_id), CHECK ((source_system IS NULL) = (source_record_id IS NULL))
);

-- document records: metadata here, the bytes stay in mig_files (with their SHA-256). One record per file AND what it
-- belongs to: source_record_id is the SHA-256 for an unlinked document, "<sha256>:<entity>:<record id>" for a linked
-- one, so the same file attached to two records is two links, and a re-run finds both.
CREATE TABLE dev_documents (
  id text PRIMARY KEY, org_id text NOT NULL REFERENCES organisations(id), source_system text, source_record_id text,
  mig_job_id text REFERENCES mig_jobs(id), mig_batch_id text REFERENCES mig_batches(id), created_at timestamptz NOT NULL DEFAULT now(),
  file_id        text NOT NULL REFERENCES mig_files(id),
  filename       text NOT NULL,
  size_bytes     bigint NOT NULL,
  sha256         text NOT NULL,
  detected_type  text NOT NULL,
  original_ref   text NOT NULL,
  -- what it belongs to (NULL = kept unlinked by decision)
  link_entity    text,
  link_id        text,
  UNIQUE (org_id, source_system, source_record_id), CHECK ((source_system IS NULL) = (source_record_id IS NULL))
);
