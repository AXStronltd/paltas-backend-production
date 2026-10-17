-- Preserve every receipt and allocation; approved corrections remove them only from effective balances.
CREATE TABLE pm_payment_reversals (
 payment_id text PRIMARY KEY REFERENCES pm_payments(id),
 org_id text NOT NULL REFERENCES organisations(id),
 reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 3 AND 1000),
 requested_by text NOT NULL REFERENCES users(id),
 requested_at timestamptz NOT NULL DEFAULT now(),
 approved_by text REFERENCES users(id),
 approved_at timestamptz,
 rejected_by text REFERENCES users(id),
 rejected_reason text,
 rejected_at timestamptz,
 date date,
 CHECK (approved_by IS NULL OR approved_by <> requested_by),
 CHECK (approved_by IS NULL OR rejected_by IS NULL),
 CHECK ((rejected_by IS NULL) = (rejected_reason IS NULL)),
 CHECK ((rejected_by IS NULL) = (rejected_at IS NULL)),
 CHECK ((approved_by IS NULL) = (approved_at IS NULL)),
 CHECK ((approved_by IS NULL) = (date IS NULL))
);
CREATE VIEW pm_effective_payments AS SELECT p.* FROM pm_payments p WHERE NOT EXISTS
 (SELECT 1 FROM pm_payment_reversals r WHERE r.payment_id=p.id AND r.approved_by IS NOT NULL);
CREATE VIEW pm_effective_allocations AS SELECT a.* FROM pm_allocations a WHERE NOT EXISTS
 (SELECT 1 FROM pm_payment_reversals r WHERE r.payment_id=a.payment_id AND r.approved_by IS NOT NULL);
CREATE INDEX pm_payments_page ON pm_payments(org_id,date DESC,number DESC,id DESC);
CREATE OR REPLACE FUNCTION pm_allocations_within_limits() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  inv_amount bigint;
  inv_alloc bigint;
  pay_amount bigint;
  pay_alloc bigint;
BEGIN
  SELECT amount_minor INTO inv_amount FROM pm_invoices WHERE id = NEW.invoice_id;
  SELECT COALESCE(sum(amount_minor), 0) INTO inv_alloc FROM pm_effective_allocations WHERE invoice_id = NEW.invoice_id;
  IF inv_alloc > inv_amount THEN
    RAISE EXCEPTION 'Invoice % would be allocated % of %', NEW.invoice_id, inv_alloc, inv_amount USING ERRCODE = 'PA005';
  END IF;
  IF NEW.payment_id IS NOT NULL THEN
    SELECT amount_minor INTO pay_amount FROM pm_payments WHERE id = NEW.payment_id;
    SELECT COALESCE(sum(amount_minor), 0) INTO pay_alloc FROM pm_effective_allocations WHERE payment_id = NEW.payment_id;
    IF pay_alloc > pay_amount THEN
      RAISE EXCEPTION 'Payment % would be allocated % of %', NEW.payment_id, pay_alloc, pay_amount USING ERRCODE = 'PA005';
    END IF;
  END IF;
  RETURN NULL;
END $$;
