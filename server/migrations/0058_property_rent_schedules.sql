-- Additive schedule metadata. Existing invoice amounts, journals and customer records are unchanged.
ALTER TABLE pm_invoices ADD COLUMN rent_from date;
ALTER TABLE pm_invoices ADD COLUMN rent_through date;
ALTER TABLE pm_invoices ADD COLUMN billing_key text;
ALTER TABLE pm_invoices ADD CONSTRAINT pm_rent_interval_valid CHECK (
  (rent_from IS NULL AND rent_through IS NULL) OR (kind='rent' AND rent_from IS NOT NULL AND rent_through IS NOT NULL AND rent_through>=rent_from));
ALTER TABLE pm_invoices ADD CONSTRAINT pm_scheduled_rent_metadata CHECK (billing_key IS NULL OR (kind='rent' AND rent_from IS NOT NULL AND rent_through IS NOT NULL));
CREATE UNIQUE INDEX pm_invoice_rent_start ON pm_invoices(lease_id,rent_from) WHERE kind='rent' AND rent_from IS NOT NULL;
CREATE UNIQUE INDEX pm_invoice_billing_key ON pm_invoices(org_id,billing_key) WHERE billing_key IS NOT NULL;
DROP INDEX pm_invoices_rent_once;
CREATE UNIQUE INDEX pm_invoices_rent_once ON pm_invoices(lease_id,period) WHERE kind='rent' AND billing_key IS NULL;
CREATE INDEX pm_invoice_rent_ranges ON pm_invoices(org_id,lease_id,rent_from,rent_through) WHERE kind='rent';
CREATE TABLE pm_rent_schedules (
 id text PRIMARY KEY,
 org_id text NOT NULL REFERENCES organisations(id),
 lease_id text NOT NULL UNIQUE REFERENCES pm_leases(id),
 property_id text NOT NULL REFERENCES pm_properties(id),
 cadence text NOT NULL CHECK(cadence IN ('weekly','monthly','quarterly','annual','custom_days')),
 every_days integer CHECK(every_days BETWEEN 1 AND 365),
 starts_on date NOT NULL,
 anchor_date date NOT NULL,
 next_date date NOT NULL,
 due_days integer NOT NULL CHECK(due_days BETWEEN 0 AND 28),
 status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','paused','completed')),
 version integer NOT NULL DEFAULT 1,
 reason text NOT NULL,
 last_error text,
 created_by text REFERENCES users(id),
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 CHECK((cadence='custom_days')=(every_days IS NOT NULL))
);
CREATE INDEX pm_rent_schedules_due ON pm_rent_schedules(property_id,next_date) WHERE status='active';
