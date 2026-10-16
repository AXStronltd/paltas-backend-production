-- The PALTAS catalogue on every database, production included: every module and every plan of the five products.
--
-- Until now only `setup:local` / `bootstrap` (seedCatalogue) added the modules and the Property Management and
-- Development plans, so on a database created by migrations alone sign-up for those two products failed and every
-- module-gated write answered "… is not in your plan". The Hotel, Security and Agency plans come from 0005, 0009 and
-- 0010 and are not repeated here.
--
-- Safe on a populated database (additive only):
--   * every row is inserted with ON CONFLICT DO NOTHING, so a module or plan that already exists — including one a
--     Super Admin has changed — is never overwritten;
--   * nothing is deleted or renamed; no organisation, account or subscription is created or changed. Existing
--     subscriptions get their plan's modules because the entitlement rules read the plan's module list against the
--     modules that now exist.
--
-- Prices are INITIAL VALUES (KES, per month, VAT 16 % as configured by PALTAS), the same as seedCatalogue
-- (core/catalogue/catalogue.seed.ts) and the owner's DEV-PRO price of KES 150,000 a month. They stay catalogue rows:
-- a Super Admin changes them with a price change request a second Super Admin approves (CATALOGUE_PRICE_APPROVAL).

-- ---------------------------------------------------------------- modules (key, name, products, dependencies, price)
INSERT INTO catalogue_modules (key, name, products, deps, price_minor, price_ccy) VALUES
  ('crm', 'Advanced CRM and Marketing', ARRAY['property', 'agency', 'developer', 'hotel'], ARRAY[]::text[], 500000, 'KES'),
  ('maint', 'Maintenance and SLA Management', ARRAY['property', 'hotel'], ARRAY[]::text[], 300000, 'KES'),
  ('finance', 'Finance and Accounting', ARRAY['property', 'agency', 'developer', 'hotel', 'security'], ARRAY[]::text[],
   600000, 'KES'),
  ('payments', 'Payments and Banking Integrations', ARRAY['property', 'agency', 'developer', 'hotel', 'security'],
   ARRAY['finance'], 400000, 'KES'),
  ('procurement', 'Supplier and Procurement Management', ARRAY['property', 'developer', 'hotel'], ARRAY['finance'],
   300000, 'KES'),
  ('intelligence', 'Advanced Reports and Intelligence', ARRAY['property', 'developer', 'hotel'], ARRAY['finance'],
   400000, 'KES'),
  ('docs', 'Document Intelligence', ARRAY['property', 'agency', 'developer', 'hotel', 'security'], ARRAY[]::text[],
   200000, 'KES'),
  ('automation', 'Workflow Automation', ARRAY['property', 'agency', 'developer', 'hotel', 'security'], ARRAY[]::text[],
   250000, 'KES')
ON CONFLICT (key) DO NOTHING;

-- ---------------------------------------------------------------- Property Management and Development plans
-- Enterprise plans have no price: they are agreed with PALTAS (sign-up refuses them and offers an enquiry).
INSERT INTO catalogue_plans (id, name, tier, product, modules, buildings_included, base_minor, extra_building_minor,
  currency, trial_days, tax_pct, tax_note, cap_sites, cap_units)
VALUES
  ('PM-STARTER', 'Property Management — Standard', 'Standard', 'property', ARRAY['maint', 'finance', 'docs'], 1,
   2500000, 1500000, 'KES', 30, 16, 'Demo configuration — VAT as configured by PALTAS; confirm with your tax adviser',
   2, 100),
  ('PM-GROWTH', 'Property Management — Pro', 'Pro', 'property',
   ARRAY['crm', 'maint', 'finance', 'payments', 'procurement', 'intelligence', 'docs'], 3, 6000000, 1200000, 'KES', 30,
   16, 'Demo configuration — VAT as configured by PALTAS; confirm with your tax adviser', 10, 1000),
  ('PM-ENTERPRISE', 'Property Management — Enterprise', 'Enterprise', 'property',
   ARRAY['crm', 'maint', 'finance', 'payments', 'procurement', 'intelligence', 'docs', 'automation'], 10, NULL, NULL,
   NULL, 30, 16, 'Demo configuration — VAT as configured by PALTAS; confirm with your tax adviser', NULL, NULL),
  ('DEV-STD', 'Property Development — Standard', 'Standard', 'developer',
   ARRAY['crm', 'finance', 'payments', 'procurement'], 1, 8000000, NULL, 'KES', 30, 16,
   'Demo configuration — VAT as configured by PALTAS; confirm with your tax adviser', 1, 300),
  ('DEV-PRO', 'Property Development — Pro', 'Pro', 'developer',
   ARRAY['crm', 'finance', 'payments', 'procurement', 'intelligence'], 5, 15000000, NULL, 'KES', 30, 16,
   'Demo configuration — VAT as configured by PALTAS; confirm with your tax adviser', 5, 2000),
  ('DEV-ENTERPRISE', 'Property Development — Enterprise', 'Enterprise', 'developer',
   ARRAY['crm', 'finance', 'payments', 'procurement', 'intelligence', 'automation'], 20, NULL, NULL, NULL, 30, 16,
   'Demo configuration — VAT as configured by PALTAS; confirm with your tax adviser', NULL, NULL)
ON CONFLICT (id) DO NOTHING;

-- The owner's DEV-PRO price (KES 150,000 a month). An older seed left DEV-PRO without a price ("contact sales"); a
-- row still EXACTLY as that seed wrote it, which no Super Admin has ever saved or asked to re-price, gets the price.
-- Any row a person has touched keeps what they set.
UPDATE catalogue_plans p SET base_minor = 15000000, currency = 'KES', updated_at = now()
WHERE p.id = 'DEV-PRO' AND p.base_minor IS NULL AND p.extra_building_minor IS NULL AND p.currency IS NULL
  AND p.tier = 'Pro' AND p.name = 'Property Development — Pro'
  AND p.modules = ARRAY['crm', 'finance', 'payments', 'procurement', 'intelligence']
  AND NOT EXISTS (SELECT 1 FROM audit_log a WHERE a.target = 'DEV-PRO' AND a.action IN ('Plan changed', 'Plan created'))
  AND NOT EXISTS (SELECT 1 FROM catalogue_price_changes c WHERE c.target_kind = 'plan' AND c.target_id = 'DEV-PRO');
