-- Add published offers; never rewrite existing plans, subscriptions, invoices or operating currency.
-- Reuse each tier's existing entitlements. Where no Enterprise template exists, retain Pro capacity
-- and include the existing workflow automation module rather than inventing unlimited capacity.
INSERT INTO catalogue_plans
(id,name,tier,product,modules,buildings_included,base_minor,extra_building_minor,currency,frequency,
 trial_days,tax_pct,tax_note,cap_sites,cap_units,active)
SELECT 'PALTAS-20261027-'||p.product||'-'||v.tier,
       split_part(p.name,' — ',1)||' — '||v.tier,v.tier,p.product,
       CASE WHEN v.tier='Enterprise' THEN ARRAY(SELECT DISTINCT x FROM unnest(p.modules||ARRAY['automation']) x ORDER BY x) ELSE p.modules END,
       p.buildings_included,v.amount,NULL,'USD','monthly',p.trial_days,0,
       'Published monthly price. No tax is added to this amount; statutory tax treatment follows the verified seller configuration.',
       p.cap_sites,p.cap_units,true
FROM (VALUES
 ('PM-STARTER','Standard',4900),('PM-GROWTH','Pro',6900),('PM-ENTERPRISE','Enterprise',9900),
 ('DEV-STD','Standard',4900),('DEV-PRO','Pro',6900),('DEV-ENTERPRISE','Enterprise',9900),
 ('AGENCY-STD','Standard',4900),('AGENCY-PRO','Pro',6900),('AGENCY-PRO','Enterprise',9900),
 ('HOTEL-STD','Standard',4900),('HOTEL-PRO','Pro',6900),('HOTEL-PRO','Enterprise',9900),
 ('SEC-STD','Standard',4900),('SEC-PRO','Pro',6900),('SEC-PRO','Enterprise',9900)
) v(source_id,tier,amount) JOIN catalogue_plans p ON p.id=v.source_id
ON CONFLICT (id) DO NOTHING;
