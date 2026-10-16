-- Property Management — Enterprise: every Property Management module, priced by PALTAS on request ("Talk to us"),
-- and open for a free trial from sign-up (the platform trial policy still sets the days).
--
-- Additive and idempotent:
--   * the plan is inserted with ON CONFLICT DO NOTHING, so a plan a Super Admin has already changed is never overwritten
--     (its modules, price and caps stay as they set them);
--   * `trial_signup` is a new column: true only for PM-ENTERPRISE. No price is invented: base and extra prices stay
--     NULL, so the plan shows "Talk to us"; the organisation's currency comes from the product's priced plans.

ALTER TABLE catalogue_plans ADD COLUMN IF NOT EXISTS trial_signup boolean NOT NULL DEFAULT false;
COMMENT ON COLUMN catalogue_plans.trial_signup IS
  'A plan PALTAS prices on request that a business may still start a free trial of from sign-up.';

INSERT INTO catalogue_plans (id, name, tier, product, modules, buildings_included, base_minor, extra_building_minor,
  currency, trial_days, tax_pct, tax_note, cap_sites, cap_units)
VALUES
  ('PM-ENTERPRISE', 'Property Management — Enterprise', 'Enterprise', 'property',
   ARRAY['crm', 'maint', 'finance', 'payments', 'procurement', 'intelligence', 'docs', 'automation'], 10, NULL, NULL,
   NULL, 30, 16, 'Priced with PALTAS — VAT as configured by PALTAS; confirm with your tax adviser', NULL, NULL)
ON CONFLICT (id) DO NOTHING;

UPDATE catalogue_plans SET trial_signup = true WHERE id = 'PM-ENTERPRISE';

-- ---------------------------------------------------------------- data migration as a catalogue module
-- "migration" is the module key for bringing a company's records and opening balances from another system. It is in
-- Property Management — Enterprise. No price is invented (NULL: not sold on its own); a Super Admin adds it to other
-- plans or prices it in the catalogue.
INSERT INTO catalogue_modules (key, name, products, deps, price_minor, price_ccy)
VALUES ('migration', 'Data Migration', ARRAY['property'], ARRAY[]::text[], NULL, NULL)
ON CONFLICT (key) DO NOTHING;
UPDATE catalogue_plans SET modules = array_append(modules, 'migration')
WHERE id = 'PM-ENTERPRISE' AND NOT ('migration' = ANY (modules));

-- ---------------------------------------------------------------- what each plan includes, in words
-- The public plan comparison (index.html, account.html sign-up) is built from these rows: each feature belongs to an
-- area and either to a module (included in the plans that have the module) or to every plan (module_key NULL).
-- Catalogue rows: PALTAS staff change them; inserted once, never overwritten.
CREATE TABLE catalogue_features (
  id          text PRIMARY KEY,
  product     text NOT NULL CHECK (product IN ('property', 'developer', 'agency', 'hotel', 'security')),
  area        text NOT NULL,
  area_order  integer NOT NULL,
  label       text NOT NULL,
  module_key  text REFERENCES catalogue_modules(key),
  sort        integer NOT NULL
);
COMMENT ON TABLE catalogue_features IS
  'Plan comparison: a feature in words, its area, and the module that brings it (NULL = every plan of the product).';

INSERT INTO catalogue_features (id, product, area, area_order, label, module_key, sort) VALUES
  ('pm-portfolio', 'property', 'Properties & tenants', 1, 'Properties, blocks and units, with a stacking plan', NULL, 1),
  ('pm-tenants', 'property', 'Properties & tenants', 1, 'Tenant profiles with contacts, emergency contact and documents', NULL, 2),
  ('pm-leases', 'property', 'Properties & tenants', 1, 'Leases, renewals, rent reviews, notice and move-out', NULL, 3),
  ('pm-owners', 'property', 'Properties & tenants', 1, 'Owners and management agreements', NULL, 4),
  ('pm-notices', 'property', 'Properties & tenants', 1, 'Notices to tenants and a document register', NULL, 5),
  ('pm-tasks', 'property', 'Properties & tenants', 1, 'Tasks, follow-ups and a shared calendar', NULL, 6),
  ('pm-crm-pipeline', 'property', 'CRM', 2, 'Leads, pipeline stages, viewings and applications to lease', 'crm', 1),
  ('pm-crm-segments', 'property', 'CRM', 2, 'Segments and lists of contacts', 'crm', 2),
  ('pm-crm-campaigns', 'property', 'CRM', 2, 'Campaigns recorded per contact, with consent checks', 'crm', 3),
  ('pm-crm-reports', 'property', 'CRM', 2, 'Pipeline, source and conversion reports', 'crm', 4),
  ('pm-pay-record', 'property', 'Payments', 3, 'Receipts by bank transfer, cash, cheque or mobile money, numbered in order', NULL, 1),
  ('pm-pay-allocate', 'property', 'Payments', 3, 'Allocation to invoices, credits, deposits and arrears with late fees', NULL, 2),
  ('pm-pay-bank', 'property', 'Payments', 3, 'Bank statement import, matching and reconciliation', 'payments', 3),
  ('pm-pay-runs', 'property', 'Payments', 3, 'Supplier payment runs and credit refunds with approval', 'payments', 4),
  ('pm-pay-reminders', 'property', 'Payments', 3, 'Payment reminders and a payments dashboard checked against the ledger', 'payments', 5),
  ('pm-acc-ledger', 'property', 'Accounting', 4, 'Chart of accounts, journals with approval, trial balance and month close', 'finance', 1),
  ('pm-acc-statements', 'property', 'Accounting', 4, 'Profit and loss, balance sheet and cash flow', 'finance', 2),
  ('pm-acc-owners', 'property', 'Accounting', 4, 'Owner statements, client money and payouts with approval', 'finance', 3),
  ('pm-acc-tax', 'property', 'Accounting', 4, 'VAT returns, budgets, service-charge funds and payroll', 'finance', 4),
  ('pm-maint-requests', 'property', 'Maintenance', 5, 'Repair requests, work orders, inspections and service levels', 'maint', 1),
  ('pm-maint-procure', 'property', 'Maintenance', 5, 'Quotes, purchase orders, supplier register and aged payables', 'procurement', 2),
  ('pm-rep-basic', 'property', 'Reports', 6, 'Rent roll, arrears, owner statements and a management dashboard', NULL, 1),
  ('pm-rep-intel', 'property', 'Reports', 6, 'Twelve-month trends, income by property and budget against actual', 'intelligence', 2),
  ('pm-rep-auto', 'property', 'Reports', 6, 'Automatic monthly billing and late fees', 'automation', 3),
  ('pm-migration', 'property', 'Data migration', 7, 'Bring your records and opening balances from another system', 'migration', 1),
  ('pm-portal-tenant', 'property', 'Portals', 8, 'Tenant portal: invoices, payments, repairs and shared documents', NULL, 1),
  ('pm-portal-owner', 'property', 'Portals', 8, 'Owner portal: statement, approvals and payouts', NULL, 2)
ON CONFLICT (id) DO NOTHING;
