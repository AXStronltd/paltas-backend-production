-- Ledger hardening after the independent review of 14 October 2026. Closes ways to get around the ledger rules with
-- direct SQL, and a race between closing a month and posting into it.
--   * journal lines can never be updated (only added while a journal is prepared);
--   * a journal's identity, organisation, date, amounts' context and preparer can never change after it is created;
--   * a manual journal must name its preparer;
--   * reversed_by may only point at the posted reversal of this journal, in the same organisation;
--   * posting into a month and closing that month are serialised by a per-(organisation, month) lock.

-- ---------------------------------------------------------------- lines are write-once
CREATE OR REPLACE FUNCTION ledger_protect_lines() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  st text;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'Journal lines cannot be changed — reverse the journal instead' USING ERRCODE = 'PA003';
  END IF;
  SELECT status INTO st FROM journal_entries WHERE id = OLD.entry_id;
  IF st IN ('posted', 'rejected') THEN
    RAISE EXCEPTION 'Lines of a % journal cannot be changed', st USING ERRCODE = 'PA003';
  END IF;
  RETURN OLD;
END $$;

-- ---------------------------------------------------------------- journals: what may change, and when
CREATE OR REPLACE FUNCTION ledger_protect_posted_entry() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  r record;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'awaiting_approval' THEN
      RAISE EXCEPTION '% journal % cannot be deleted — reverse it instead', initcap(OLD.status), OLD.number USING ERRCODE = 'PA003';
    END IF;
    RETURN OLD;
  END IF;
  -- what a journal is never changes after it is created
  IF (NEW.id, NEW.org_id, NEW.number, NEW.date, NEW.memo, NEW.currency, NEW.source, NEW.source_ref, NEW.prepared_by, NEW.reverses, NEW.created_at)
     IS DISTINCT FROM
     (OLD.id, OLD.org_id, OLD.number, OLD.date, OLD.memo, OLD.currency, OLD.source, OLD.source_ref, OLD.prepared_by, OLD.reverses, OLD.created_at) THEN
    RAISE EXCEPTION 'Journal % cannot be edited — reject it and prepare a new one', OLD.number USING ERRCODE = 'PA003';
  END IF;
  IF OLD.status = 'posted' THEN
    -- the only change allowed on a posted journal: recording, once, the posted journal that reverses it
    IF NEW.reversed_by IS NOT NULL AND OLD.reversed_by IS NULL
       AND (to_jsonb(NEW) - 'reversed_by') = (to_jsonb(OLD) - 'reversed_by') THEN
      SELECT org_id, reverses, status INTO r FROM journal_entries WHERE id = NEW.reversed_by;
      IF r.org_id IS DISTINCT FROM OLD.org_id OR r.reverses IS DISTINCT FROM OLD.id OR r.status IS DISTINCT FROM 'posted' THEN
        RAISE EXCEPTION 'Journal % can only be marked reversed by its own posted reversal', OLD.number USING ERRCODE = 'PA003';
      END IF;
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'Posted journal % cannot be changed — reverse it instead', OLD.number USING ERRCODE = 'PA003';
  END IF;
  IF OLD.status = 'rejected' THEN
    RAISE EXCEPTION 'Rejected journal % cannot be changed', OLD.number USING ERRCODE = 'PA003';
  END IF;
  IF NEW.reversed_by IS NOT NULL THEN
    RAISE EXCEPTION 'Only a posted journal can be marked reversed' USING ERRCODE = 'PA003';
  END IF;
  RETURN NEW;
END $$;

ALTER TABLE journal_entries
  ADD CONSTRAINT manual_journal_names_preparer CHECK (source <> 'manual' OR prepared_by IS NOT NULL);

-- ---------------------------------------------------------------- balanced, and every line in the journal's organisation
CREATE OR REPLACE FUNCTION ledger_assert_balanced(p_entry text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  e record;
  dr numeric;
  cr numeric;
  n integer;
  foreign_lines integer;
BEGIN
  SELECT id, number, status, org_id INTO e FROM journal_entries WHERE id = p_entry;
  IF e.status IS DISTINCT FROM 'posted' THEN RETURN; END IF;
  SELECT COALESCE(sum(debit_minor), 0), COALESCE(sum(credit_minor), 0), count(*),
         count(*) FILTER (WHERE org_id <> e.org_id)
    INTO dr, cr, n, foreign_lines FROM journal_lines WHERE entry_id = p_entry;
  IF foreign_lines > 0 THEN
    RAISE EXCEPTION 'Journal % has lines from another organisation', e.number USING ERRCODE = 'PA002';
  END IF;
  IF n < 2 OR dr <> cr OR dr = 0 THEN
    RAISE EXCEPTION 'Journal % does not balance (debits %, credits %, lines %)', e.number, dr, cr, n
      USING ERRCODE = 'PA002';
  END IF;
END $$;

-- ---------------------------------------------------------------- closing a month vs posting into it
-- Posting takes a shared lock on (organisation, month); closing takes the exclusive one (ledger.service setPeriod),
-- so a close and a posting can never both succeed unseen by each other.
CREATE OR REPLACE FUNCTION ledger_period_lock_key(p_org text, p_date date) RETURNS bigint LANGUAGE sql IMMUTABLE AS $$
  SELECT hashtextextended('ledger-period:' || p_org || ':' || to_char(p_date, 'YYYY-MM'), 0)
$$;

CREATE OR REPLACE FUNCTION ledger_refuse_closed_period() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = 'posted' AND (TG_OP = 'INSERT' OR OLD.status <> 'posted') THEN
    PERFORM pg_advisory_xact_lock_shared(ledger_period_lock_key(NEW.org_id, NEW.date));
    IF EXISTS (
      SELECT 1 FROM ledger_periods
      WHERE org_id = NEW.org_id AND month = date_trunc('month', NEW.date)::date AND status = 'closed'
    ) THEN
      RAISE EXCEPTION '% is closed — reopen it before posting into it', to_char(NEW.date, 'FMMonth YYYY')
        USING ERRCODE = 'PA001';
    END IF;
  END IF;
  RETURN NEW;
END $$;
