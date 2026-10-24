-- Additive configuration only. Existing bills/invoices are not recalculated.
CREATE TABLE pm_utility_tariffs (
 id text PRIMARY KEY, org_id text NOT NULL REFERENCES organisations(id), charge_type_id text NOT NULL REFERENCES pm_charge_types(id),
 unit_id text REFERENCES pm_units(id), effective_period char(7) NOT NULL CHECK(effective_period ~ '^\d{4}-(0[1-9]|1[0-2])$'),
 tiers jsonb NOT NULL CHECK(jsonb_typeof(tiers)='array'), fixed_minor bigint NOT NULL CHECK(fixed_minor>=0),
 meter_serial text NOT NULL DEFAULT '', reason text NOT NULL, created_by text NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX pm_tariff_global_period ON pm_utility_tariffs(org_id,charge_type_id,effective_period) WHERE unit_id IS NULL;
CREATE UNIQUE INDEX pm_tariff_unit_period ON pm_utility_tariffs(org_id,charge_type_id,unit_id,effective_period) WHERE unit_id IS NOT NULL;
CREATE TRIGGER pm_tariffs_immutable BEFORE UPDATE OR DELETE ON pm_utility_tariffs FOR EACH ROW EXECUTE FUNCTION audit_log_is_append_only();
ALTER TABLE pm_invoice_lines ADD COLUMN pricing_snapshot jsonb;
CREATE TABLE pm_expense_categories (
 id text PRIMARY KEY,org_id text NOT NULL REFERENCES organisations(id),name text NOT NULL CHECK(length(btrim(name)) BETWEEN 2 AND 160),
 base_category text NOT NULL CHECK(base_category IN ('repairs','utilities','cleaning','security','administration','bank_charges','other')),
 tax_code text NOT NULL DEFAULT '', active boolean NOT NULL DEFAULT true, version integer NOT NULL DEFAULT 1 CHECK(version>0),created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(org_id,id)
);
CREATE UNIQUE INDEX pm_expense_category_name ON pm_expense_categories(org_id,lower(btrim(name)));
ALTER TABLE pm_bills ADD COLUMN custom_category_id text;
ALTER TABLE pm_bills ADD COLUMN custom_category_name text;
ALTER TABLE pm_bills ADD COLUMN custom_tax_code text;
ALTER TABLE pm_bills ADD CONSTRAINT pm_bill_custom_category_org FOREIGN KEY(org_id,custom_category_id) REFERENCES pm_expense_categories(org_id,id);

-- Reinforce organisation boundaries even if a future writer misses a service-level check.
ALTER TABLE pm_charge_types ADD CONSTRAINT pm_charge_type_org_identity UNIQUE(org_id,id);
ALTER TABLE pm_units ADD CONSTRAINT pm_unit_org_identity UNIQUE(org_id,id);
ALTER TABLE pm_utility_tariffs ADD CONSTRAINT pm_tariff_charge_org FOREIGN KEY(org_id,charge_type_id) REFERENCES pm_charge_types(org_id,id);
ALTER TABLE pm_utility_tariffs ADD CONSTRAINT pm_tariff_unit_org FOREIGN KEY(org_id,unit_id) REFERENCES pm_units(org_id,id);
