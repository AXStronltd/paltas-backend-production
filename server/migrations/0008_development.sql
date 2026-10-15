-- Real Estate Development, the day-to-day product. Builds on the dev_* records of migration 0006 (the data-migration
-- target): the same tables are extended, nothing is duplicated, and migrated records work with every endpoint.
--
-- Rules the database itself keeps:
--   * a unit has at most one open reservation and at most one live contract (no double-selling);
--   * the person who prepared a record cannot approve it: requisitions, purchase orders, budget changes, supplier
--     invoices, payment runs (and the approver cannot execute it), price lists, suppliers, bank-detail changes,
--     reported buyer payments, reservations, offer terms; the person who executed a payment cannot reconcile it;
--   * a reported buyer payment reference is used once; a supplier payment reference is unique;
--   * money is integer minor units; shares are basis points (1000 = 10 %).
-- Buyers are linked to the organisation's ONE contact store (contacts, migration 0007).
-- Money posts to the ONE ledger through postSystemJournal (source "system:development"), with the project, cost code,
-- contract or supplier in each line's dimensions.

-- ============================================================== settings, approval limits, cost codes
CREATE TABLE dev_settings (
  org_id                 text PRIMARY KEY REFERENCES organisations(id),
  reservation_days       integer NOT NULL DEFAULT 14 CHECK (reservation_days BETWEEN 1 AND 120),
  price_tolerance_bp     integer NOT NULL DEFAULT 200 CHECK (price_tolerance_bp BETWEEN 0 AND 10000),
  bank_hold_hours        integer NOT NULL DEFAULT 48 CHECK (bank_hold_hours BETWEEN 0 AND 720),
  -- offer terms beyond these need a sales manager, then the chief executive
  manager_discount_bp    integer NOT NULL DEFAULT 200 CHECK (manager_discount_bp BETWEEN 0 AND 10000),
  executive_discount_bp  integer NOT NULL DEFAULT 500 CHECK (executive_discount_bp BETWEEN 0 AND 10000),
  min_deposit_bp         integer NOT NULL DEFAULT 1000 CHECK (min_deposit_bp BETWEEN 0 AND 10000),
  manager_max_months     integer NOT NULL DEFAULT 12 CHECK (manager_max_months BETWEEN 0 AND 36),
  executive_max_months   integer NOT NULL DEFAULT 18 CHECK (executive_max_months BETWEEN 0 AND 36),
  updated_by             text REFERENCES users(id),
  updated_at             timestamptz NOT NULL DEFAULT now()
);

-- what each role may approve, per kind; no row = that role cannot approve that kind; NULL limit = no limit
CREATE TABLE dev_approval_limits (
  org_id       text NOT NULL REFERENCES organisations(id),
  kind         text NOT NULL CHECK (kind IN ('requisition', 'purchase_order', 'invoice', 'budget_change', 'payment_run')),
  role         text NOT NULL,
  limit_minor  bigint CHECK (limit_minor >= 0),
  PRIMARY KEY (org_id, kind, role)
);

-- the cost breakdown structure; each code posts to one ledger account (a WIP asset or an expense)
CREATE TABLE dev_cost_codes (
  org_id        text NOT NULL REFERENCES organisations(id),
  code          text NOT NULL,
  name          text NOT NULL,
  account_code  text NOT NULL,
  active        boolean NOT NULL DEFAULT true,
  PRIMARY KEY (org_id, code),
  FOREIGN KEY (org_id, account_code) REFERENCES ledger_accounts(org_id, code)
);

-- ============================================================== projects, units, documents
ALTER TABLE dev_projects
  ADD COLUMN stage text,
  ADD COLUMN progress_pct integer NOT NULL DEFAULT 0 CHECK (progress_pct BETWEEN 0 AND 100),
  ADD COLUMN forecast_end_date date;

ALTER TABLE dev_units DROP CONSTRAINT dev_units_status_check;
ALTER TABLE dev_units
  ADD CONSTRAINT dev_units_status_check
    CHECK (status IN ('available', 'on_hold', 'reserved', 'sold', 'handed_over', 'blocked'));
CREATE INDEX dev_units_project ON dev_units (project_id);

ALTER TABLE dev_milestones
  ADD COLUMN forecast_date date,
  ADD COLUMN practical_completion boolean NOT NULL DEFAULT false;

-- document records made in PALTAS carry metadata only (the bytes stay with the uploader's storage); migrated ones
-- keep pointing at their mig_files bytes
ALTER TABLE dev_documents ALTER COLUMN file_id DROP NOT NULL;
ALTER TABLE dev_documents
  ADD COLUMN kind text,
  ADD COLUMN uploaded_by text REFERENCES users(id);

CREATE TABLE dev_price_lists (
  id              text PRIMARY KEY,
  org_id          text NOT NULL REFERENCES organisations(id),
  number          text NOT NULL,
  project_id      text NOT NULL REFERENCES dev_projects(id),
  effective_date  date NOT NULL,
  note            text NOT NULL DEFAULT '',
  status          text NOT NULL CHECK (status IN ('draft', 'approved', 'rejected')),
  prepared_by     text NOT NULL REFERENCES users(id),
  approved_by     text REFERENCES users(id),
  decided_at      timestamptz,
  reason          text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, number),
  CONSTRAINT dev_price_list_second_person CHECK (approved_by IS NULL OR approved_by <> prepared_by)
);

CREATE TABLE dev_price_list_items (
  price_list_id    text NOT NULL REFERENCES dev_price_lists(id),
  unit_id          text NOT NULL REFERENCES dev_units(id),
  old_price_minor  bigint,
  price_minor      bigint NOT NULL CHECK (price_minor > 0),
  PRIMARY KEY (price_list_id, unit_id)
);

-- ============================================================== buyers, offers, reservations, contracts
ALTER TABLE dev_contacts
  ADD COLUMN agent_user_id text REFERENCES users(id),
  ADD COLUMN source text,
  ADD COLUMN status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'lost', 'merged')),
  ADD COLUMN merged_into text REFERENCES dev_contacts(id),
  ADD COLUMN next_follow_up date,
  ADD COLUMN created_by text REFERENCES users(id),
  -- the person in the organisation's ONE contact store (core contacts, migration 0007); merging contacts there
  -- moves this link with them
  ADD COLUMN contact_id text REFERENCES contacts(id),
  ADD CONSTRAINT dev_contact_merge_target CHECK ((status = 'merged') = (merged_into IS NOT NULL));
CREATE INDEX dev_contacts_contact ON dev_contacts (contact_id);

CREATE TABLE dev_offers (
  id                     text PRIMARY KEY,
  org_id                 text NOT NULL REFERENCES organisations(id),
  number                 text NOT NULL,
  buyer_id               text NOT NULL REFERENCES dev_contacts(id),
  unit_id                text NOT NULL REFERENCES dev_units(id),
  project_id             text NOT NULL REFERENCES dev_projects(id),
  asking_minor           bigint NOT NULL CHECK (asking_minor > 0),
  price_minor            bigint NOT NULL CHECK (price_minor > 0),
  deposit_bp             integer NOT NULL,
  instalments_bp         integer NOT NULL,
  months                 integer NOT NULL CHECK (months BETWEEN 0 AND 36),
  completion_bp          integer NOT NULL,
  valid_days             integer NOT NULL CHECK (valid_days BETWEEN 1 AND 30),
  valid_until            date,
  conditions             text NOT NULL DEFAULT '',
  status                 text NOT NULL CHECK (status IN ('draft', 'awaiting_approval', 'submitted', 'counteroffer',
                                                         'accepted', 'rejected', 'withdrawn', 'expired')),
  round                  integer NOT NULL DEFAULT 1,
  agent_user_id          text REFERENCES users(id),
  created_by             text NOT NULL REFERENCES users(id),
  approval_level         text CHECK (approval_level IN ('manager', 'executive')),
  approval_status        text CHECK (approval_status IN ('pending', 'approved', 'declined')),
  -- a fingerprint of the terms approved: changing any term withdraws the approval
  approval_terms         text,
  approval_after         text CHECK (approval_after IN ('submit', 'accept')),
  approval_requested_by  text REFERENCES users(id),
  approval_decided_by    text REFERENCES users(id),
  approval_reason        text,
  counter                jsonb,
  reservation_id         text,
  created_at             timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, number),
  CHECK (deposit_bp + instalments_bp + completion_bp = 10000),
  CONSTRAINT dev_offer_approver_not_preparer CHECK (
    approval_decided_by IS NULL OR (approval_decided_by <> created_by
      AND approval_decided_by IS DISTINCT FROM agent_user_id AND approval_decided_by IS DISTINCT FROM approval_requested_by))
);
CREATE INDEX dev_offers_unit ON dev_offers (unit_id);

ALTER TABLE dev_reservations DROP CONSTRAINT dev_reservations_status_check;
ALTER TABLE dev_reservations
  ADD CONSTRAINT dev_reservations_status_check
    CHECK (status IN ('awaiting_approval', 'active', 'converted', 'cancelled', 'expired')),
  ADD COLUMN offer_id text REFERENCES dev_offers(id),
  ADD COLUMN requested_by text REFERENCES users(id),
  ADD COLUMN approved_by text REFERENCES users(id),
  ADD COLUMN cancel_reason text,
  ADD CONSTRAINT dev_reservation_second_person CHECK (approved_by IS NULL OR approved_by IS DISTINCT FROM requested_by);
-- no double-selling: one open reservation per unit
-- Rows imported before this migration (data migration 0006 did not check this) may already break the rule: then the
-- rule covers every record made from now on and imported rows are left as they are, so this migration never fails
-- on a live database. A clean database gets the rule for every row.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM dev_reservations WHERE status IN ('awaiting_approval', 'active') GROUP BY unit_id HAVING count(*) > 1) THEN
    RAISE NOTICE 'dev_reservations_one_open_per_unit: imported rows already break the rule; enforcing it for rows not imported';
    CREATE UNIQUE INDEX dev_reservations_one_open_per_unit ON dev_reservations (unit_id) WHERE status IN ('awaiting_approval', 'active') AND mig_job_id IS NULL;
  ELSE
    CREATE UNIQUE INDEX dev_reservations_one_open_per_unit ON dev_reservations (unit_id) WHERE status IN ('awaiting_approval', 'active');
  END IF;
END $$;
ALTER TABLE dev_offers ADD FOREIGN KEY (reservation_id) REFERENCES dev_reservations(id);

ALTER TABLE dev_contracts
  ADD COLUMN offer_id text REFERENCES dev_offers(id),
  ADD COLUMN deposit_bp integer,
  ADD COLUMN instalments_bp integer,
  ADD COLUMN months integer,
  ADD COLUMN completion_bp integer,
  ADD COLUMN signed_document_id text REFERENCES dev_documents(id),
  ADD COLUMN signed_by text REFERENCES users(id);
-- no double-selling: one live contract per unit
-- Rows imported before this migration (data migration 0006 did not check this) may already break the rule: then the
-- rule covers every record made from now on and imported rows are left as they are, so this migration never fails
-- on a live database. A clean database gets the rule for every row.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM dev_contracts WHERE status IS DISTINCT FROM 'cancelled' GROUP BY unit_id HAVING count(*) > 1) THEN
    RAISE NOTICE 'dev_contracts_one_live_per_unit: imported rows already break the rule; enforcing it for rows not imported';
    CREATE UNIQUE INDEX dev_contracts_one_live_per_unit ON dev_contracts (unit_id) WHERE status IS DISTINCT FROM 'cancelled' AND mig_job_id IS NULL;
  ELSE
    CREATE UNIQUE INDEX dev_contracts_one_live_per_unit ON dev_contracts (unit_id) WHERE status IS DISTINCT FROM 'cancelled';
  END IF;
END $$;

-- receivable_minor: billed and unpaid, held in 1170 Buyer receivables (the subledger behind that account)
ALTER TABLE dev_instalments
  ADD COLUMN billed boolean NOT NULL DEFAULT false,
  ADD COLUMN receivable_minor bigint NOT NULL DEFAULT 0 CHECK (receivable_minor >= 0),
  ADD COLUMN bill_journal_id text REFERENCES journal_entries(id);

ALTER TABLE dev_payments
  ADD COLUMN receipt_no text,
  ADD COLUMN journal_id text REFERENCES journal_entries(id),
  ADD COLUMN verified_by text REFERENCES users(id);

CREATE TABLE dev_payment_reports (
  id                 text PRIMARY KEY,
  org_id             text NOT NULL REFERENCES organisations(id),
  number             text NOT NULL,
  contract_id        text NOT NULL REFERENCES dev_contracts(id),
  instalment_id      text REFERENCES dev_instalments(id),
  buyer_id           text NOT NULL REFERENCES dev_contacts(id),
  amount_minor       bigint NOT NULL CHECK (amount_minor > 0),
  method             text NOT NULL,
  reference          text NOT NULL,
  date               date NOT NULL,
  proof_document_id  text REFERENCES dev_documents(id),
  source             text NOT NULL,
  status             text NOT NULL CHECK (status IN ('awaiting_verification', 'verified', 'rejected')),
  reported_by        text NOT NULL REFERENCES users(id),
  verified_by        text REFERENCES users(id),
  decided_at         timestamptz,
  reason             text,
  payment_id         text REFERENCES dev_payments(id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, number),
  CONSTRAINT dev_payment_verified_by_second_person CHECK (verified_by IS NULL OR verified_by <> reported_by)
);
-- the same bank or mobile-money reference is never recorded twice
CREATE UNIQUE INDEX dev_payment_reports_reference ON dev_payment_reports (org_id, upper(reference))
  WHERE status <> 'rejected';

ALTER TABLE dev_disputes
  ADD COLUMN resolution text,
  ADD COLUMN resolved_by text REFERENCES users(id);

ALTER TABLE dev_correspondence ADD COLUMN recorded_by text REFERENCES users(id);

-- ============================================================== handover, defects, tasks, legal register
ALTER TABLE dev_handovers
  ADD COLUMN certificate_document_id text REFERENCES dev_documents(id),
  ADD COLUMN completed_by text REFERENCES users(id),
  ADD COLUMN revenue_journal_id text REFERENCES journal_entries(id),
  ADD COLUMN cost_journal_id text REFERENCES journal_entries(id),
  ADD COLUMN revenue_minor bigint NOT NULL DEFAULT 0,
  ADD COLUMN cost_minor bigint NOT NULL DEFAULT 0;
-- Rows imported before this migration (data migration 0006 did not check this) may already break the rule: then the
-- rule covers every record made from now on and imported rows are left as they are, so this migration never fails
-- on a live database. A clean database gets the rule for every row.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM dev_handovers WHERE status = 'completed' GROUP BY unit_id HAVING count(*) > 1) THEN
    RAISE NOTICE 'dev_handovers_once_per_unit: imported rows already break the rule; enforcing it for rows not imported';
    CREATE UNIQUE INDEX dev_handovers_once_per_unit ON dev_handovers (unit_id) WHERE status = 'completed' AND mig_job_id IS NULL;
  ELSE
    CREATE UNIQUE INDEX dev_handovers_once_per_unit ON dev_handovers (unit_id) WHERE status = 'completed';
  END IF;
END $$;

CREATE TABLE dev_tasks (
  id                text PRIMARY KEY,
  org_id            text NOT NULL REFERENCES organisations(id),
  title             text NOT NULL,
  description       text NOT NULL DEFAULT '',
  due_date          date NOT NULL,
  priority          text NOT NULL CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
  status            text NOT NULL CHECK (status IN ('open', 'done', 'cancelled')),
  category          text NOT NULL CHECK (category IN ('sales', 'finance', 'aftersales', 'site', 'general')),
  assignee_user_id  text NOT NULL REFERENCES users(id),
  created_by        text REFERENCES users(id),
  buyer_id          text REFERENCES dev_contacts(id),
  unit_id           text REFERENCES dev_units(id),
  project_id        text REFERENCES dev_projects(id),
  contract_id       text REFERENCES dev_contracts(id),
  -- automatic tasks carry a key so the same task is never created twice
  key               text,
  done_at           timestamptz,
  done_by           text REFERENCES users(id),
  note              text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, key)
);
CREATE INDEX dev_tasks_assignee ON dev_tasks (org_id, assignee_user_id, status);

ALTER TABLE dev_defects
  ADD COLUMN fixed_date date,
  ADD COLUMN fixed_by text REFERENCES users(id),
  ADD COLUMN closed_by text REFERENCES users(id),
  ADD COLUMN task_id text REFERENCES dev_tasks(id),
  ADD CONSTRAINT dev_defect_closed_by_second_person CHECK (closed_by IS NULL OR closed_by IS DISTINCT FROM fixed_by);

CREATE TABLE dev_legal_items (
  id           text PRIMARY KEY,
  org_id       text NOT NULL REFERENCES organisations(id),
  project_id   text NOT NULL REFERENCES dev_projects(id),
  title        text NOT NULL,
  kind         text NOT NULL CHECK (kind IN ('title', 'approval', 'licence', 'insurance', 'contract', 'certificate', 'other')),
  expiry_date  date,
  in_progress  boolean NOT NULL DEFAULT false,
  document_id  text REFERENCES dev_documents(id),
  created_by   text NOT NULL REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- ============================================================== suppliers and bank-detail changes
ALTER TABLE dev_suppliers
  ADD COLUMN status text NOT NULL DEFAULT 'approved' CHECK (status IN ('pending', 'approved', 'suspended')),
  ADD COLUMN related_party boolean NOT NULL DEFAULT false,
  ADD COLUMN related_note text,
  ADD COLUMN missing_documents text[] NOT NULL DEFAULT '{}',
  ADD COLUMN bank_account text,
  ADD COLUMN bank_verified_at timestamptz,
  ADD COLUMN rating numeric(2, 1) CHECK (rating BETWEEN 0 AND 5),
  ADD COLUMN registered_by text REFERENCES users(id),
  ADD COLUMN approved_by text REFERENCES users(id),
  ADD CONSTRAINT dev_supplier_second_person CHECK (approved_by IS NULL OR approved_by IS DISTINCT FROM registered_by);

CREATE TABLE dev_bank_changes (
  id             text PRIMARY KEY,
  org_id         text NOT NULL REFERENCES organisations(id),
  supplier_id    text NOT NULL REFERENCES dev_suppliers(id),
  new_account    text NOT NULL,
  received_via   text NOT NULL,
  logged_by      text NOT NULL REFERENCES users(id),
  status         text NOT NULL CHECK (status IN ('pending_verification', 'on_hold', 'verified')),
  verified_by    text REFERENCES users(id),
  callback_note  text,
  hold_until     timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT dev_bank_change_second_person CHECK (verified_by IS NULL OR verified_by <> logged_by)
);

-- ============================================================== budgets and procurement
CREATE TABLE dev_budget_lines (
  org_id          text NOT NULL REFERENCES organisations(id),
  project_id      text NOT NULL REFERENCES dev_projects(id),
  cost_code       text NOT NULL,
  original_minor  bigint NOT NULL DEFAULT 0 CHECK (original_minor >= 0),
  original_set    boolean NOT NULL DEFAULT false,
  -- the uncommitted forecast (quantity surveyor's estimate for scope with no order yet)
  etc_minor       bigint NOT NULL DEFAULT 0 CHECK (etc_minor >= 0),
  note            text NOT NULL DEFAULT '',
  PRIMARY KEY (project_id, cost_code),
  FOREIGN KEY (org_id, cost_code) REFERENCES dev_cost_codes(org_id, code)
);

CREATE TABLE dev_budget_changes (
  id               text PRIMARY KEY,
  org_id           text NOT NULL REFERENCES organisations(id),
  number           text NOT NULL,
  project_id       text NOT NULL REFERENCES dev_projects(id),
  kind             text NOT NULL CHECK (kind IN ('transfer', 'change_order')),
  from_code        text NOT NULL,
  to_code          text NOT NULL,
  amount_minor     bigint NOT NULL CHECK (amount_minor > 0),
  reason           text NOT NULL,
  status           text NOT NULL CHECK (status IN ('pending', 'approved', 'rejected')),
  requested_by     text NOT NULL REFERENCES users(id),
  approved_by      text REFERENCES users(id),
  decided_at       timestamptz,
  decision_reason  text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, number),
  CHECK (from_code <> to_code),
  CONSTRAINT dev_budget_change_second_person CHECK (approved_by IS NULL OR approved_by <> requested_by)
);

CREATE TABLE dev_requisitions (
  id                    text PRIMARY KEY,
  org_id                text NOT NULL REFERENCES organisations(id),
  number                text NOT NULL,
  project_id            text NOT NULL REFERENCES dev_projects(id),
  cost_code             text NOT NULL,
  item                  text NOT NULL,
  qty                   numeric(14, 3) NOT NULL CHECK (qty > 0),
  unit                  text NOT NULL,
  est_unit_price_minor  bigint NOT NULL CHECK (est_unit_price_minor > 0),
  need_by               date,
  status                text NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'rfq', 'ordered')),
  requested_by          text NOT NULL REFERENCES users(id),
  approved_by           text REFERENCES users(id),
  decided_at            timestamptz,
  reason                text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, number),
  CONSTRAINT dev_requisition_second_person CHECK (approved_by IS NULL OR approved_by <> requested_by)
);

ALTER TABLE dev_purchase_orders DROP CONSTRAINT dev_purchase_orders_status_check;
ALTER TABLE dev_purchase_orders
  ADD CONSTRAINT dev_purchase_orders_status_check
    CHECK (status IN ('pending_approval', 'approved', 'rejected', 'open', 'received', 'closed', 'cancelled')),
  ADD COLUMN kind text NOT NULL DEFAULT 'po' CHECK (kind IN ('po', 'contract')),
  ADD COLUMN cost_code text,
  ADD COLUMN retention_bp integer NOT NULL DEFAULT 0 CHECK (retention_bp BETWEEN 0 AND 10000),
  ADD COLUMN prepared_by text REFERENCES users(id),
  ADD COLUMN approved_by text REFERENCES users(id),
  ADD COLUMN decided_at timestamptz,
  ADD COLUMN decision_reason text,
  ADD COLUMN requisition_id text REFERENCES dev_requisitions(id),
  ADD CONSTRAINT dev_purchase_order_second_person CHECK (approved_by IS NULL OR approved_by IS DISTINCT FROM prepared_by);

CREATE TABLE dev_po_lines (
  id                text PRIMARY KEY,
  org_id            text NOT NULL REFERENCES organisations(id),
  po_id             text NOT NULL REFERENCES dev_purchase_orders(id),
  line_no           integer NOT NULL,
  item              text NOT NULL,
  unit              text NOT NULL,
  qty               numeric(14, 3) NOT NULL CHECK (qty > 0),
  unit_price_minor  bigint NOT NULL CHECK (unit_price_minor > 0),
  UNIQUE (po_id, line_no)
);

CREATE TABLE dev_rfqs (
  id                   text PRIMARY KEY,
  org_id               text NOT NULL REFERENCES organisations(id),
  number               text NOT NULL,
  requisition_id       text NOT NULL UNIQUE REFERENCES dev_requisitions(id),
  closes               date NOT NULL,
  status               text NOT NULL CHECK (status IN ('open', 'awarded')),
  invited              text[] NOT NULL,
  awarded_supplier_id  text REFERENCES dev_suppliers(id),
  purchase_order_id    text REFERENCES dev_purchase_orders(id),
  award_reason         text,
  created_by           text NOT NULL REFERENCES users(id),
  created_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, number)
);

CREATE TABLE dev_rfq_bids (
  rfq_id            text NOT NULL REFERENCES dev_rfqs(id),
  supplier_id       text NOT NULL REFERENCES dev_suppliers(id),
  unit_price_minor  bigint NOT NULL CHECK (unit_price_minor > 0),
  lead_days         integer NOT NULL CHECK (lead_days > 0),
  note              text NOT NULL DEFAULT '',
  recorded_by       text NOT NULL REFERENCES users(id),
  PRIMARY KEY (rfq_id, supplier_id)
);

CREATE TABLE dev_deliveries (
  id           text PRIMARY KEY,
  org_id       text NOT NULL REFERENCES organisations(id),
  number       text NOT NULL,
  po_id        text NOT NULL REFERENCES dev_purchase_orders(id),
  date         date NOT NULL,
  note         text NOT NULL DEFAULT '',
  received_by  text NOT NULL REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, number)
);

CREATE TABLE dev_delivery_lines (
  delivery_id   text NOT NULL REFERENCES dev_deliveries(id),
  po_line_id    text NOT NULL REFERENCES dev_po_lines(id),
  received_qty  numeric(14, 3) NOT NULL CHECK (received_qty > 0),
  accepted_qty  numeric(14, 3) NOT NULL CHECK (accepted_qty >= 0 AND accepted_qty <= received_qty),
  PRIMARY KEY (delivery_id, po_line_id)
);

-- ============================================================== supplier invoices, credit notes, payments
CREATE TABLE dev_supplier_invoices (
  id                    text PRIMARY KEY,
  org_id                text NOT NULL REFERENCES organisations(id),
  number                text NOT NULL,
  kind                  text NOT NULL CHECK (kind IN ('invoice', 'retention_release')),
  supplier_id           text NOT NULL REFERENCES dev_suppliers(id),
  project_id            text NOT NULL REFERENCES dev_projects(id),
  cost_code             text,
  po_id                 text REFERENCES dev_purchase_orders(id),
  supplier_invoice_no   text NOT NULL,
  -- the number without spaces or symbols, lower case: how duplicates are found
  normalized_no         text NOT NULL,
  date                  date NOT NULL,
  due_date              date NOT NULL,
  description           text NOT NULL,
  net_minor             bigint NOT NULL CHECK (net_minor >= 0),
  credit_minor          bigint NOT NULL DEFAULT 0 CHECK (credit_minor >= 0),
  vat_bp                integer NOT NULL DEFAULT 0 CHECK (vat_bp BETWEEN 0 AND 10000),
  wht_bp                integer NOT NULL DEFAULT 0 CHECK (wht_bp BETWEEN 0 AND 10000),
  retention_bp          integer NOT NULL DEFAULT 0 CHECK (retention_bp BETWEEN 0 AND 10000),
  vat_minor             bigint NOT NULL DEFAULT 0,
  retention_minor       bigint NOT NULL DEFAULT 0,
  wht_minor             bigint NOT NULL DEFAULT 0,
  payable_minor         bigint NOT NULL CHECK (payable_minor >= 0),
  cash_minor            bigint NOT NULL CHECK (cash_minor >= 0),
  status                text NOT NULL CHECK (status IN ('captured', 'matched', 'exception', 'approved', 'in_run', 'sent',
                                                        'paid', 'disputed', 'rejected', 'duplicate')),
  exceptions            text[] NOT NULL DEFAULT '{}',
  captured_by           text NOT NULL REFERENCES users(id),
  approved_by           text REFERENCES users(id),
  approved_at           timestamptz,
  override_by           text REFERENCES users(id),
  override_reason       text,
  evidence_document_id  text REFERENCES dev_documents(id),
  dispute_amount_minor  bigint,
  dispute_reason        text,
  dispute_status        text CHECK (dispute_status IN ('open', 'settled')),
  journal_id            text REFERENCES journal_entries(id),
  created_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, number),
  CONSTRAINT dev_invoice_second_person CHECK (approved_by IS NULL OR approved_by <> captured_by)
);
CREATE INDEX dev_supplier_invoices_supplier ON dev_supplier_invoices (org_id, supplier_id);

CREATE TABLE dev_invoice_lines (
  invoice_id        text NOT NULL REFERENCES dev_supplier_invoices(id),
  line_no           integer NOT NULL,
  po_line_id        text NOT NULL REFERENCES dev_po_lines(id),
  qty               numeric(14, 3) NOT NULL CHECK (qty > 0),
  credited_qty      numeric(14, 3) NOT NULL DEFAULT 0 CHECK (credited_qty >= 0 AND credited_qty <= qty),
  unit_price_minor  bigint NOT NULL CHECK (unit_price_minor > 0),
  PRIMARY KEY (invoice_id, line_no)
);

CREATE TABLE dev_credit_notes (
  id                  text PRIMARY KEY,
  org_id              text NOT NULL REFERENCES organisations(id),
  invoice_id          text NOT NULL REFERENCES dev_supplier_invoices(id),
  supplier_credit_no  text NOT NULL,
  reason              text NOT NULL,
  net_minor           bigint NOT NULL CHECK (net_minor > 0),
  created_by          text NOT NULL REFERENCES users(id),
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE dev_payment_runs (
  id           text PRIMARY KEY,
  org_id       text NOT NULL REFERENCES organisations(id),
  number       text NOT NULL,
  status       text NOT NULL CHECK (status IN ('awaiting_approval', 'approved', 'sent', 'reconciled', 'rejected')),
  prepared_by  text NOT NULL REFERENCES users(id),
  approved_by  text REFERENCES users(id),
  executed_by  text REFERENCES users(id),
  approved_at  timestamptz,
  executed_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, number),
  CONSTRAINT dev_run_approver_not_preparer CHECK (approved_by IS NULL OR approved_by <> prepared_by),
  CONSTRAINT dev_run_executor_not_approver CHECK (executed_by IS NULL OR executed_by <> approved_by)
);

CREATE TABLE dev_payment_run_items (
  run_id        text NOT NULL REFERENCES dev_payment_runs(id),
  invoice_id    text NOT NULL REFERENCES dev_supplier_invoices(id),
  amount_minor  bigint NOT NULL CHECK (amount_minor > 0),
  PRIMARY KEY (run_id, invoice_id)
);

CREATE TABLE dev_supplier_payments (
  id                   text PRIMARY KEY,
  org_id               text NOT NULL REFERENCES organisations(id),
  run_id               text NOT NULL REFERENCES dev_payment_runs(id),
  invoice_id           text NOT NULL REFERENCES dev_supplier_invoices(id),
  supplier_id          text NOT NULL REFERENCES dev_suppliers(id),
  amount_minor         bigint NOT NULL CHECK (amount_minor > 0),
  wht_minor            bigint NOT NULL DEFAULT 0 CHECK (wht_minor >= 0),
  reference            text NOT NULL,
  status               text NOT NULL CHECK (status IN ('sent', 'reconciled', 'reversed')),
  journal_id           text REFERENCES journal_entries(id),
  executed_by          text NOT NULL REFERENCES users(id),
  reconciled_by        text REFERENCES users(id),
  reconciled_at        timestamptz,
  statement_date       date,
  reversal_journal_id  text REFERENCES journal_entries(id),
  reverse_reason       text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, reference),
  CONSTRAINT dev_payment_reconciled_by_other CHECK (reconciled_by IS NULL OR reconciled_by <> executed_by)
);
