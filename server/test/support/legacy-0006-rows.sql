-- Representative rows of a LIVE database that has only migrations 0001–0006 (what paltas-v2-db held before the
-- 0007–0013 round), written the way the 0006-era code writes them. Used by live-upgrade.migrations.test.ts.
-- The catalogue (seedCatalogue) and the first Super Admin (the first `npm run bootstrap`) are added by the test.

-- ---------------------------------------------------------------- organisations, people, memberships
INSERT INTO organisations (id, name, legal_name, country, currency, timezone, discount_pct, terms_note) VALUES
  ('org_legacy_pm', 'Kilima Homes', 'Kilima Homes Ltd', 'Kenya', 'KES', 'Africa/Nairobi', 0, ''),
  ('org_legacy_hotel', 'Pwani Beach Hotel', 'Pwani Beach Hotel Ltd', 'Kenya', 'KES', 'Africa/Nairobi', 10, 'Launch discount'),
  ('org_legacy_dev', 'Savanna Developers', 'Savanna Developers Ltd', 'Kenya', 'KES', 'Africa/Nairobi', 0, '');

INSERT INTO users (id, email, name, password_hash, must_change_password) VALUES
  ('usr_legacy_pm_admin', 'admin@kilima.test', 'Kilima Admin', 'scrypt$legacy$not-a-real-hash', false),
  ('usr_legacy_pm_invited', 'new@kilima.test', 'Invited Person', 'scrypt$legacy$not-a-real-hash', true),
  ('usr_legacy_hotel_admin', 'gm@pwani.test', 'Pwani GM', 'scrypt$legacy$not-a-real-hash', false),
  ('usr_legacy_dev_admin', 'cfo@savanna.test', 'Savanna CFO', 'scrypt$legacy$not-a-real-hash', false),
  ('usr_legacy_dev_acct', 'acct@savanna.test', 'Savanna Accountant', 'scrypt$legacy$not-a-real-hash', false);

INSERT INTO memberships (org_id, user_id, role, status) VALUES
  ('org_legacy_pm', 'usr_legacy_pm_admin', 'org_admin', 'active'),
  ('org_legacy_pm', 'usr_legacy_pm_invited', 'viewer', 'invited'),
  ('org_legacy_hotel', 'usr_legacy_hotel_admin', 'org_admin', 'active'),
  ('org_legacy_dev', 'usr_legacy_dev_admin', 'org_admin', 'active'),
  ('org_legacy_dev', 'usr_legacy_dev_acct', 'accountant', 'suspended');

-- ---------------------------------------------------------------- subscriptions (a running trial, active ones, an add-on)
INSERT INTO subscriptions (org_id, product, plan_id, status, trial_ends, anchor, buildings_extra, buildings_override) VALUES
  ('org_legacy_pm', 'property', 'PM-STARTER', 'trial', '2026-10-30', NULL, 0, NULL),
  ('org_legacy_hotel', 'hotel', 'HOTEL-STD', 'active', NULL, '2026-10-01', 0, NULL),
  ('org_legacy_dev', 'developer', 'DEV-PRO', 'active', NULL, '2026-10-01', 2, 8);
INSERT INTO subscription_addons (org_id, product, module_key, since) VALUES
  ('org_legacy_hotel', 'hotel', 'docs', '2026-10-01');

-- ---------------------------------------------------------------- subscription invoices: open, paid, void
INSERT INTO billing_invoices (id, org_id, product, period_from, period_to, lines, gross_minor, discount_minor, net_minor,
  tax_pct, tax_minor, total_minor, currency, status, issued, due, paid_at, paid_event, note) VALUES
  ('SUB-LEGACY-1', 'org_legacy_hotel', 'hotel', '2026-10-01', '2026-10-31', '[{"kind":"plan","what":"Hotel Standard","amountMinor":2000000}]',
   2000000, 200000, 1800000, 16, 288000, 2088000, 'KES', 'Paid', '2026-10-01', '2026-10-08', now(), 'evt_legacy_1', 'Issued by PALTAS'),
  ('SUB-LEGACY-2', 'org_legacy_dev', 'developer', '2026-10-01', '2026-10-31', '[{"kind":"plan","what":"Developer Pro","amountMinor":15000000}]',
   15000000, 0, 15000000, 16, 2400000, 17400000, 'KES', 'Open', '2026-10-01', '2026-10-08', NULL, NULL, 'Issued by PALTAS'),
  ('SUB-LEGACY-3', 'org_legacy_dev', 'developer', '2026-09-01', '2026-09-30', '[{"kind":"plan","what":"Developer Pro","amountMinor":15000000}]',
   15000000, 0, 15000000, 16, 2400000, 17400000, 'KES', 'Void', '2026-09-01', '2026-09-08', NULL, NULL, 'Issued by PALTAS');
INSERT INTO counters (scope, name, value) VALUES ('platform', 'SUB', 3);

INSERT INTO audit_log (actor_user, actor_role, org_id, action, target, detail) VALUES
  (NULL, 'system', 'org_legacy_pm', 'Organisation created', 'org_legacy_pm', 'legacy row'),
  ('usr_legacy_dev_admin', 'org_admin', 'org_legacy_dev', 'Member suspended', 'usr_legacy_dev_acct', 'legacy row');

-- ---------------------------------------------------------------- ledger: accounts and posted journals (one reversed)
INSERT INTO ledger_accounts (org_id, code, name, type, system) VALUES
  ('org_legacy_dev', '1000', 'Bank', 'asset', true),
  ('org_legacy_dev', '3000', 'Owner equity', 'equity', true),
  ('org_legacy_hotel', '1000', 'Bank', 'asset', true),
  ('org_legacy_hotel', '4100', 'Rooms revenue', 'income', true),
  ('org_legacy_hotel', '5100', 'Rooms expenses', 'expense', true);
INSERT INTO ledger_periods (org_id, month, status, changed_by, reason) VALUES
  ('org_legacy_dev', '2026-08-01', 'closed', 'usr_legacy_dev_admin', 'August closed');

INSERT INTO journal_entries (id, org_id, number, date, memo, currency, source, source_ref, status) VALUES
  ('je_legacy_1', 'org_legacy_dev', 'JE-0001', '2026-10-02', 'Opening capital', 'KES', 'system:migration', 'MIG-1', 'awaiting_approval'),
  ('je_legacy_2', 'org_legacy_hotel', 'JE-0001', '2026-10-03', 'Room night', 'KES', 'system:hotel', 'F-1', 'awaiting_approval');
INSERT INTO journal_lines (entry_id, line_no, org_id, account_code, debit_minor, credit_minor, memo) VALUES
  ('je_legacy_1', 1, 'org_legacy_dev', '1000', 50000000, 0, ''),
  ('je_legacy_1', 2, 'org_legacy_dev', '3000', 0, 50000000, ''),
  ('je_legacy_2', 1, 'org_legacy_hotel', '1000', 1200000, 0, ''),
  ('je_legacy_2', 2, 'org_legacy_hotel', '4100', 0, 1200000, '');
UPDATE journal_entries SET status = 'posted', posted_at = now() WHERE id IN ('je_legacy_1', 'je_legacy_2');

-- ---------------------------------------------------------------- data migration: a completed import job and its file
INSERT INTO mig_jobs (id, org_id, number, domain, name, source_system, cutover_date, currency, status, created_by,
  dry_run_by, dry_run_at, approved_by, approved_at, completed_by, completed_at, revision, dry_run_revision) VALUES
  ('mig_legacy_1', 'org_legacy_dev', 'MIG-1', 'development', 'Old CRM export', 'oldcrm', '2026-09-30', 'KES',
   'completed', 'usr_legacy_dev_admin', 'usr_legacy_dev_admin', now(), 'usr_legacy_dev_acct', now(),
   'usr_legacy_dev_admin', now(), 3, 3),
  ('mig_legacy_2', 'org_legacy_dev', 'MIG-2', 'development', 'Second batch', 'oldcrm', '2026-09-30', 'KES',
   'mapped', 'usr_legacy_dev_admin', NULL, NULL, NULL, NULL, NULL, NULL, 1, NULL);
INSERT INTO mig_files (id, org_id, job_id, filename, original_ref, declared_size, size_bytes, sha256, detected_type,
  status, content, uploaded_by) VALUES
  ('mfl_legacy_1', 'org_legacy_dev', 'mig_legacy_1', 'units.csv', 'units.csv', 12, 12,
   'a3f1b6d3c0f0e8a4a1d9e2c7b5f4e3d2c1b0a9f8e7d6c5b4a3f2e1d0c9b8a7f6', 'csv', 'stored', 'unit_no,price'::bytea,
   'usr_legacy_dev_admin');

-- ---------------------------------------------------------------- imported development records, including history
-- the 0006 importer did not stop these: two open reservations of one unit, and a resold unit with two live
-- contracts and two completed handovers. Migration 0008 must still apply.
INSERT INTO dev_projects (id, org_id, source_system, source_record_id, mig_job_id, name, code, status) VALUES
  ('dpr_legacy_1', 'org_legacy_dev', 'oldcrm', 'P1', 'mig_legacy_1', 'Savanna Heights', 'SH', 'selling');
INSERT INTO dev_units (id, org_id, source_system, source_record_id, mig_job_id, project_id, unit_no, list_price_minor, status) VALUES
  ('dun_legacy_1', 'org_legacy_dev', 'oldcrm', 'U1', 'mig_legacy_1', 'dpr_legacy_1', 'A-101', 1200000000, 'reserved'),
  ('dun_legacy_2', 'org_legacy_dev', 'oldcrm', 'U2', 'mig_legacy_1', 'dpr_legacy_1', 'A-102', 1300000000, 'handed_over'),
  ('dun_legacy_3', 'org_legacy_dev', 'oldcrm', 'U3', 'mig_legacy_1', 'dpr_legacy_1', 'A-103', 1300000000, 'available');
INSERT INTO dev_contacts (id, org_id, source_system, source_record_id, mig_job_id, kind, name, email) VALUES
  ('dct_legacy_1', 'org_legacy_dev', 'oldcrm', 'B1', 'mig_legacy_1', 'buyer', 'Amina Buyer', 'amina@buyer.test'),
  ('dct_legacy_2', 'org_legacy_dev', 'oldcrm', 'B2', 'mig_legacy_1', 'buyer', 'Brian Buyer', 'brian@buyer.test');
INSERT INTO dev_reservations (id, org_id, source_system, source_record_id, mig_job_id, unit_id, buyer_id, date, deposit_minor, status) VALUES
  ('drs_legacy_1', 'org_legacy_dev', 'oldcrm', 'R1', 'mig_legacy_1', 'dun_legacy_1', 'dct_legacy_1', '2026-08-01', 10000000, 'active'),
  ('drs_legacy_2', 'org_legacy_dev', 'oldcrm', 'R2', 'mig_legacy_1', 'dun_legacy_1', 'dct_legacy_2', '2026-08-15', 10000000, 'active');
INSERT INTO dev_contracts (id, org_id, source_system, source_record_id, mig_job_id, unit_id, buyer_id, number, date, price_minor, status) VALUES
  ('dco_legacy_1', 'org_legacy_dev', 'oldcrm', 'C1', 'mig_legacy_1', 'dun_legacy_2', 'dct_legacy_1', 'SPA-1', '2024-01-10', 1100000000, 'completed'),
  ('dco_legacy_2', 'org_legacy_dev', 'oldcrm', 'C2', 'mig_legacy_1', 'dun_legacy_2', 'dct_legacy_2', 'SPA-2', '2026-03-10', 1300000000, 'active');
INSERT INTO dev_handovers (id, org_id, source_system, source_record_id, mig_job_id, unit_id, contract_id, date, status) VALUES
  ('dho_legacy_1', 'org_legacy_dev', 'oldcrm', 'H1', 'mig_legacy_1', 'dun_legacy_2', 'dco_legacy_1', '2024-06-01', 'completed'),
  ('dho_legacy_2', 'org_legacy_dev', 'oldcrm', 'H2', 'mig_legacy_1', 'dun_legacy_2', 'dco_legacy_2', '2026-06-01', 'completed');

-- ---------------------------------------------------------------- hotel: property, room, guest, reservation, folio
INSERT INTO hotel_properties (id, org_id, name, country, city, timezone, check_in_time, check_out_time, business_date,
  vat_bp, service_charge_bp, service_charge_departments, vat_on_service_charge, levy_kind, levy_name, levy_amount_minor,
  levy_bp, require_inspection, welcome_temp_c, eco_temp_c, usali) VALUES
  ('hpr_legacy_1', 'org_legacy_hotel', 'Pwani Beach', 'Kenya', 'Mombasa', 'Africa/Nairobi', '14:00', '11:00', '2026-10-11',
   1600, 1000, ARRAY['rooms', 'fnb'], true, 'percent_of_room', 'Tourism levy', 0, 200, true, 21.0, 26.0,
   '{"rooms":{"revenue":["4100"],"costs":["5100"]},"fnb":{"revenue":["4200"],"costs":[]},"spa":{"revenue":[],"costs":[]},"other":{"revenue":[],"costs":[]},"undistributed":{"costs":["5900"]}}'),
  -- an older property whose USALI map lacks departments: the 0011 update must leave it alone, not fail
  ('hpr_legacy_2', 'org_legacy_hotel', 'Pwani Annex', 'Kenya', 'Mombasa', 'Africa/Nairobi', '14:00', '11:00', '2026-10-11',
   1600, 0, ARRAY[]::text[], false, 'none', '', 0, 0, false, 21.0, 26.0, '{}');
INSERT INTO hotel_room_types (id, org_id, property_id, code, name, capacity_adults, capacity_children, beds) VALUES
  ('hrt_legacy_1', 'org_legacy_hotel', 'hpr_legacy_1', 'DLX', 'Deluxe', 2, 1, 'King');
INSERT INTO hotel_rooms (id, org_id, property_id, room_type_id, number, floor) VALUES
  ('hrm_legacy_1', 'org_legacy_hotel', 'hpr_legacy_1', 'hrt_legacy_1', '101', '1');
INSERT INTO hotel_guests (id, org_id, name, email, phone) VALUES
  ('hgu_legacy_1', 'org_legacy_hotel', 'Grace Guest', 'grace@guest.test', '+254700000001');
INSERT INTO hotel_reservations (id, org_id, property_id, number, guest_id, arrival, departure, source) VALUES
  ('hrs_legacy_1', 'org_legacy_hotel', 'hpr_legacy_1', 'RES-1', 'hgu_legacy_1', '2026-10-10', '2026-10-13', 'direct');
INSERT INTO hotel_folios (id, org_id, property_id, number, reservation_id, name, payer) VALUES
  ('hfo_legacy_1', 'org_legacy_hotel', 'hpr_legacy_1', 'F-1', 'hrs_legacy_1', 'Grace Guest', 'guest');
INSERT INTO hotel_folio_lines (id, org_id, property_id, folio_id, business_date, kind, department, description,
  net_minor, total_minor, journal_id) VALUES
  ('hfl_legacy_1', 'org_legacy_hotel', 'hpr_legacy_1', 'hfo_legacy_1', '2026-10-10', 'charge', 'rooms', 'Room 101',
   1200000, 1200000, 'je_legacy_2');
INSERT INTO hotel_folio_lines (id, org_id, property_id, folio_id, business_date, kind, description, net_minor, total_minor, method, reference) VALUES
  ('hfl_legacy_2', 'org_legacy_hotel', 'hpr_legacy_1', 'hfo_legacy_1', '2026-10-10', 'payment', 'Card payment', 1200000, 1200000, 'card', 'AUTH-1');
INSERT INTO hotel_messages (id, org_id, property_id, reservation_id, channel, direction, body, status) VALUES
  ('hms_legacy_1', 'org_legacy_hotel', 'hpr_legacy_1', 'hrs_legacy_1', 'email', 'outbound', 'Welcome to Pwani Beach', 'sent');
