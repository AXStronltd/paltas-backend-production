-- The ONE double-entry ledger per organisation. Every product posts here; there is no second ledger.
--
-- The database itself guarantees, whatever the application does:
--   1. a posted journal balances: total debits = total credits > 0, with at least two lines;
--   2. a posted journal and its lines can never be changed or deleted (mistakes are corrected by a reversal);
--   3. nothing is posted into a closed month;
--   4. a manual journal is approved by someone other than the person who prepared it.
-- Error codes PA001–PA004 are turned into clear API errors by server/src/http/errors.ts.

CREATE TABLE ledger_accounts (
  org_id      text NOT NULL REFERENCES organisations(id),
  code        text NOT NULL CHECK (code ~ '^\d{4,6}$'),
  name        text NOT NULL,
  type        text NOT NULL CHECK (type IN ('asset', 'liability', 'equity', 'income', 'expense')),
  system      boolean NOT NULL DEFAULT false,   -- used by automatic postings: can be renamed, never deactivated
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, code),
  -- the first digit tells the type: 1 asset, 2 liability, 3 equity, 4 income, 5–9 expense
  CONSTRAINT account_code_matches_type CHECK (
    (type = 'asset' AND code LIKE '1%') OR (type = 'liability' AND code LIKE '2%') OR
    (type = 'equity' AND code LIKE '3%') OR (type = 'income' AND code LIKE '4%') OR
    (type = 'expense' AND code ~ '^[5-9]')
  ),
  CONSTRAINT system_accounts_stay_active CHECK (active OR NOT system)
);

-- a month is open unless a row here says it is closed
CREATE TABLE ledger_periods (
  org_id      text NOT NULL REFERENCES organisations(id),
  month       date NOT NULL CHECK (extract(day FROM month) = 1),
  status      text NOT NULL CHECK (status IN ('open', 'closed')),
  changed_by  text REFERENCES users(id),
  changed_at  timestamptz NOT NULL DEFAULT now(),
  reason      text NOT NULL,
  PRIMARY KEY (org_id, month)
);

CREATE TABLE journal_entries (
  id               text PRIMARY KEY,
  org_id           text NOT NULL REFERENCES organisations(id),
  number           text NOT NULL,
  date             date NOT NULL,
  memo             text NOT NULL,
  currency         char(3) NOT NULL,
  source           text NOT NULL CHECK (source = 'manual' OR source LIKE 'system:%'),
  source_ref       text,
  status           text NOT NULL CHECK (status IN ('awaiting_approval', 'posted', 'rejected')),
  prepared_by      text REFERENCES users(id),
  approved_by      text REFERENCES users(id),
  approved_at      timestamptz,
  rejected_reason  text,
  reverses         text REFERENCES journal_entries(id),
  reversed_by      text REFERENCES journal_entries(id),
  posted_at        timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, number),
  -- 4. separation of duties for manual journals
  CONSTRAINT manual_journal_needs_second_person CHECK (
    source <> 'manual' OR status <> 'posted' OR (approved_by IS NOT NULL AND approved_by IS DISTINCT FROM prepared_by)
  ),
  CHECK ((status = 'posted') = (posted_at IS NOT NULL)),
  CHECK (status <> 'rejected' OR rejected_reason IS NOT NULL)
);
CREATE INDEX journal_entries_org_date ON journal_entries (org_id, date);
-- an automatic posting is made once per source document (safe to retry)
CREATE UNIQUE INDEX journal_entries_source_once ON journal_entries (org_id, source, source_ref)
  WHERE source_ref IS NOT NULL AND status <> 'rejected';
-- a journal is reversed at most once
CREATE UNIQUE INDEX journal_entries_reversed_once ON journal_entries (reverses)
  WHERE reverses IS NOT NULL AND status <> 'rejected';

CREATE TABLE journal_lines (
  entry_id      text NOT NULL REFERENCES journal_entries(id),
  line_no       integer NOT NULL,
  org_id        text NOT NULL,
  account_code  text NOT NULL,
  debit_minor   bigint NOT NULL DEFAULT 0 CHECK (debit_minor >= 0),
  credit_minor  bigint NOT NULL DEFAULT 0 CHECK (credit_minor >= 0),
  memo          text NOT NULL DEFAULT '',
  -- product dimensions (property, unit, owner, project …) for reporting
  dimensions    jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (entry_id, line_no),
  FOREIGN KEY (org_id, account_code) REFERENCES ledger_accounts(org_id, code),
  CHECK ((debit_minor > 0) <> (credit_minor > 0))
);
CREATE INDEX journal_lines_account ON journal_lines (org_id, account_code);

-- ---------------------------------------------------------------- 1. posted journals balance
CREATE FUNCTION ledger_assert_balanced(p_entry text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  e record;
  dr bigint;
  cr bigint;
  n integer;
BEGIN
  SELECT id, number, status INTO e FROM journal_entries WHERE id = p_entry;
  IF e.status IS DISTINCT FROM 'posted' THEN RETURN; END IF;
  SELECT COALESCE(sum(debit_minor), 0), COALESCE(sum(credit_minor), 0), count(*)
    INTO dr, cr, n FROM journal_lines WHERE entry_id = p_entry;
  IF n < 2 OR dr <> cr OR dr = 0 THEN
    RAISE EXCEPTION 'Journal % does not balance (debits %, credits %, lines %)', e.number, dr, cr, n
      USING ERRCODE = 'PA002';
  END IF;
END $$;

CREATE FUNCTION ledger_check_entry_balanced() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM ledger_assert_balanced(NEW.id);
  RETURN NULL;
END $$;

CREATE FUNCTION ledger_check_line_entry_balanced() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM ledger_assert_balanced(NEW.entry_id);
  RETURN NULL;
END $$;

-- checked at COMMIT, so a journal and its lines can be written in any order inside one transaction
CREATE CONSTRAINT TRIGGER journal_entries_balanced
  AFTER INSERT OR UPDATE OF status ON journal_entries DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION ledger_check_entry_balanced();
CREATE CONSTRAINT TRIGGER journal_lines_balanced
  AFTER INSERT ON journal_lines DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION ledger_check_line_entry_balanced();

-- ---------------------------------------------------------------- 2. posted journals are permanent
CREATE FUNCTION ledger_protect_posted_entry() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status = 'posted' THEN
      RAISE EXCEPTION 'Posted journal % cannot be deleted — reverse it instead', OLD.number USING ERRCODE = 'PA003';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.status = 'posted' THEN
    -- the only change allowed on a posted journal is recording, once, the journal that reverses it
    IF NEW.reversed_by IS NOT NULL AND OLD.reversed_by IS NULL
       AND (to_jsonb(NEW) - 'reversed_by') = (to_jsonb(OLD) - 'reversed_by') THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'Posted journal % cannot be changed — reverse it instead', OLD.number USING ERRCODE = 'PA003';
  END IF;
  IF OLD.status = 'rejected' THEN
    RAISE EXCEPTION 'Rejected journal % cannot be changed', OLD.number USING ERRCODE = 'PA003';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER journal_entries_protect BEFORE UPDATE OR DELETE ON journal_entries
  FOR EACH ROW EXECUTE FUNCTION ledger_protect_posted_entry();

CREATE FUNCTION ledger_protect_lines() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  st text;
BEGIN
  SELECT status INTO st FROM journal_entries WHERE id = OLD.entry_id;
  IF st IN ('posted', 'rejected') THEN
    RAISE EXCEPTION 'Lines of a % journal cannot be changed', st USING ERRCODE = 'PA003';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER journal_lines_protect BEFORE UPDATE OR DELETE ON journal_lines
  FOR EACH ROW EXECUTE FUNCTION ledger_protect_lines();

-- lines are written only while a journal is being prepared; posting is a separate status change afterwards
CREATE FUNCTION ledger_lines_only_while_preparing() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  e record;
BEGIN
  SELECT status, org_id INTO e FROM journal_entries WHERE id = NEW.entry_id;
  IF e.status <> 'awaiting_approval' THEN
    RAISE EXCEPTION 'Lines cannot be added to a % journal', e.status USING ERRCODE = 'PA003';
  END IF;
  IF NEW.org_id <> e.org_id THEN
    RAISE EXCEPTION 'A journal line must belong to its journal''s organisation' USING ERRCODE = 'PA003';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER journal_lines_insert_guard BEFORE INSERT ON journal_lines
  FOR EACH ROW EXECUTE FUNCTION ledger_lines_only_while_preparing();

CREATE FUNCTION ledger_no_truncate() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Ledger tables cannot be emptied' USING ERRCODE = 'PA003';
END $$;
CREATE TRIGGER journal_entries_no_truncate BEFORE TRUNCATE ON journal_entries
  FOR EACH STATEMENT EXECUTE FUNCTION ledger_no_truncate();
CREATE TRIGGER journal_lines_no_truncate BEFORE TRUNCATE ON journal_lines
  FOR EACH STATEMENT EXECUTE FUNCTION ledger_no_truncate();

-- ---------------------------------------------------------------- 3. closed months
CREATE FUNCTION ledger_refuse_closed_period() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = 'posted' AND (TG_OP = 'INSERT' OR OLD.status <> 'posted') AND EXISTS (
    SELECT 1 FROM ledger_periods
    WHERE org_id = NEW.org_id AND month = date_trunc('month', NEW.date)::date AND status = 'closed'
  ) THEN
    RAISE EXCEPTION '% is closed — reopen it before posting into it', to_char(NEW.date, 'FMMonth YYYY')
      USING ERRCODE = 'PA001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER journal_entries_open_period BEFORE INSERT OR UPDATE OF status ON journal_entries
  FOR EACH ROW EXECUTE FUNCTION ledger_refuse_closed_period();
