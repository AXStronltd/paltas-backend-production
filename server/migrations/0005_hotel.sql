-- Smart Hotel (product "hotel"). Every table carries org_id; money is bigint minor units in the organisation's
-- currency; percentages are basis points (1 % = 100). Folios post to the ONE ledger (journal_entries) through
-- the ledger service; hotel_ledger_links only says which hotel and business date a posting belongs to.
-- Invariants the database itself enforces:
--   * a room type is never sold beyond its rooms for a night (hotel_inventory: sold + held + ooo <= total);
--   * a physical room never holds two overlapping stays (exclusion constraint on hotel_stays);
--   * a room night is charged at most once; a charge is voided at most once;
--   * one open cashier shift per person per hotel; a refund is approved by someone other than its requester.

CREATE EXTENSION IF NOT EXISTS btree_gist;

-- ---------------------------------------------------------------- catalogue: hotel plans (DEMO prices, like the core seed)
-- KES prices are PALTAS demo configuration, to be confirmed before any customer is billed. Super Admin changes them
-- through the admin API; nothing in the code reads a price. Never overwrites an existing plan.
INSERT INTO catalogue_plans (id, name, tier, product, modules, buildings_included, base_minor, extra_building_minor,
  currency, trial_days, tax_pct, tax_note, cap_sites, cap_units)
VALUES
  ('HOTEL-STD', 'Hotel — Standard', 'Standard', 'hotel', ARRAY['maint', 'finance', 'docs'], 1, 3000000, 2000000,
   'KES', 30, 16, 'Demo configuration — VAT as configured by PALTAS; confirm with your tax adviser', 1, 150),
  ('HOTEL-PRO', 'Hotel — Pro (groups and chains)', 'Pro', 'hotel',
   ARRAY['crm', 'maint', 'finance', 'payments', 'procurement', 'intelligence', 'docs', 'automation'], 5, 9000000, 1500000,
   'KES', 30, 16, 'Demo configuration — VAT as configured by PALTAS; confirm with your tax adviser', 20, 3000)
ON CONFLICT (id) DO NOTHING;

-- ---------------------------------------------------------------- properties and set-up
CREATE TABLE hotel_properties (
  id                          text PRIMARY KEY,
  org_id                      text NOT NULL REFERENCES organisations(id),
  name                        text NOT NULL,
  country                     text NOT NULL,
  city                        text NOT NULL,
  timezone                    text NOT NULL,
  check_in_time               text NOT NULL,
  check_out_time              text NOT NULL,
  business_date               date NOT NULL,          -- moved on only by the night audit
  vat_bp                      integer NOT NULL CHECK (vat_bp BETWEEN 0 AND 10000),
  service_charge_bp           integer NOT NULL CHECK (service_charge_bp BETWEEN 0 AND 10000),
  service_charge_departments  text[] NOT NULL,
  vat_on_service_charge       boolean NOT NULL,
  levy_kind                   text NOT NULL CHECK (levy_kind IN ('none', 'per_night', 'percent_of_room')),
  levy_name                   text NOT NULL,
  levy_amount_minor           bigint NOT NULL CHECK (levy_amount_minor >= 0),
  levy_bp                     integer NOT NULL CHECK (levy_bp BETWEEN 0 AND 10000),
  require_inspection          boolean NOT NULL,
  welcome_temp_c              numeric(4,1) NOT NULL,
  eco_temp_c                  numeric(4,1) NOT NULL,
  faq                         jsonb NOT NULL DEFAULT '[]',
  usali                       jsonb NOT NULL,         -- departmental account mapping (USALI-style P&L)
  created_at                  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX hotel_properties_name ON hotel_properties (org_id, lower(name));

-- members assigned to a hotel; a member assigned to any hotel only sees the hotels they are assigned to
CREATE TABLE hotel_property_staff (
  property_id  text NOT NULL REFERENCES hotel_properties(id),
  org_id       text NOT NULL,
  user_id      text NOT NULL REFERENCES users(id),
  PRIMARY KEY (property_id, user_id)
);
CREATE INDEX hotel_property_staff_user ON hotel_property_staff (org_id, user_id);

CREATE TABLE hotel_room_types (
  id                 text PRIMARY KEY,
  org_id             text NOT NULL,
  property_id        text NOT NULL REFERENCES hotel_properties(id),
  code               text NOT NULL,
  name               text NOT NULL,
  capacity_adults    integer NOT NULL CHECK (capacity_adults > 0),
  capacity_children  integer NOT NULL CHECK (capacity_children >= 0),
  beds               text NOT NULL,
  size_sqm           numeric(8,2),
  amenities          text[] NOT NULL DEFAULT '{}',
  UNIQUE (property_id, code)
);

CREATE TABLE hotel_rooms (
  id              text PRIMARY KEY,
  org_id          text NOT NULL,
  property_id     text NOT NULL REFERENCES hotel_properties(id),
  room_type_id    text NOT NULL REFERENCES hotel_room_types(id),
  number          text NOT NULL,
  floor           text NOT NULL DEFAULT '',
  attributes      text[] NOT NULL DEFAULT '{}',
  hk_status       text NOT NULL DEFAULT 'clean' CHECK (hk_status IN ('dirty', 'cleaning', 'clean', 'inspected')),
  service_status  text NOT NULL DEFAULT 'in_service' CHECK (service_status IN ('in_service', 'out_of_order', 'out_of_service')),
  eco_mode        boolean NOT NULL DEFAULT false,
  hk_started_at   timestamptz,
  hk_finished_at  timestamptz,
  UNIQUE (property_id, number)
);

CREATE TABLE hotel_corporate_accounts (
  id                  text PRIMARY KEY,
  org_id              text NOT NULL REFERENCES organisations(id),
  name                text NOT NULL,
  kind                text NOT NULL CHECK (kind IN ('company', 'travel_agent')),
  credit_limit_minor  bigint NOT NULL CHECK (credit_limit_minor >= 0),
  contact_email       text,
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX hotel_corporate_accounts_name ON hotel_corporate_accounts (org_id, lower(name));

CREATE TABLE hotel_channels (
  id             text PRIMARY KEY,
  org_id         text NOT NULL,
  property_id    text NOT NULL REFERENCES hotel_properties(id),
  code           text NOT NULL,
  name           text NOT NULL,
  provider       text NOT NULL,
  commission_bp  integer NOT NULL CHECK (commission_bp BETWEEN 0 AND 10000),
  active         boolean NOT NULL DEFAULT true,
  UNIQUE (property_id, code)
);

CREATE TABLE hotel_outlets (
  id              text PRIMARY KEY,
  org_id          text NOT NULL,
  property_id     text NOT NULL REFERENCES hotel_properties(id),
  code            text NOT NULL,
  name            text NOT NULL,
  department      text NOT NULL CHECK (department IN ('rooms', 'fnb', 'spa', 'other')),
  staff_user_ids  text[] NOT NULL DEFAULT '{}',
  UNIQUE (property_id, code)
);

CREATE TABLE hotel_rate_plans (
  id                    text PRIMARY KEY,
  org_id                text NOT NULL,
  property_id           text NOT NULL REFERENCES hotel_properties(id),
  code                  text NOT NULL,
  name                  text NOT NULL,
  kind                  text NOT NULL CHECK (kind IN ('bar', 'derived', 'non_refundable', 'breakfast', 'corporate', 'long_stay', 'package')),
  parent_id             text REFERENCES hotel_rate_plans(id),
  derived_bp            integer,                       -- e.g. -1000 = parent minus 10 %
  breakfast_included    boolean NOT NULL DEFAULT false,
  refundable            boolean NOT NULL,
  free_cancel_days      integer NOT NULL CHECK (free_cancel_days >= 0),
  cancel_fee_nights     integer NOT NULL CHECK (cancel_fee_nights >= 0),
  no_show_fee_nights    integer NOT NULL CHECK (no_show_fee_nights >= 0),
  corporate_account_id  text REFERENCES hotel_corporate_accounts(id),
  active                boolean NOT NULL DEFAULT true,
  UNIQUE (property_id, code),
  CHECK ((kind = 'derived') = (parent_id IS NOT NULL AND derived_bp IS NOT NULL)),
  CHECK (parent_id IS DISTINCT FROM id)
);

CREATE TABLE hotel_rate_prices (
  rate_plan_id  text NOT NULL REFERENCES hotel_rate_plans(id),
  room_type_id  text NOT NULL REFERENCES hotel_room_types(id),
  amount_minor  bigint NOT NULL CHECK (amount_minor > 0),
  PRIMARY KEY (rate_plan_id, room_type_id)
);

CREATE TABLE hotel_rate_seasons (
  id               text PRIMARY KEY,
  rate_plan_id     text NOT NULL REFERENCES hotel_rate_plans(id),
  room_type_id     text NOT NULL REFERENCES hotel_room_types(id),
  name             text NOT NULL,
  date_from        date NOT NULL,
  date_to          date NOT NULL,
  amount_minor     bigint NOT NULL CHECK (amount_minor > 0),
  weekday_minor    bigint[],                           -- 7 entries, Monday first; NULL entry = season amount
  CHECK (date_to >= date_from),
  CHECK (weekday_minor IS NULL OR cardinality(weekday_minor) = 7)
);

CREATE TABLE hotel_restrictions (
  id            text PRIMARY KEY,
  org_id        text NOT NULL,
  property_id   text NOT NULL REFERENCES hotel_properties(id),
  room_type_id  text REFERENCES hotel_room_types(id),
  rate_plan_id  text REFERENCES hotel_rate_plans(id),
  channel_id    text REFERENCES hotel_channels(id),
  date_from     date NOT NULL,
  date_to       date NOT NULL,
  min_stay      integer CHECK (min_stay > 0),
  max_stay      integer CHECK (max_stay > 0),
  cta           boolean NOT NULL DEFAULT false,
  ctd           boolean NOT NULL DEFAULT false,
  stop_sell     boolean NOT NULL DEFAULT false,
  CHECK (date_to >= date_from)
);
CREATE INDEX hotel_restrictions_property ON hotel_restrictions (property_id);

-- ---------------------------------------------------------------- THE availability record
-- one row per room type and night; every channel and the front desk sell from it
CREATE TABLE hotel_inventory (
  org_id        text NOT NULL,
  property_id   text NOT NULL REFERENCES hotel_properties(id),
  room_type_id  text NOT NULL REFERENCES hotel_room_types(id),
  date          date NOT NULL,
  total         integer NOT NULL CHECK (total >= 0),
  sold          integer NOT NULL DEFAULT 0 CHECK (sold >= 0),
  held          integer NOT NULL DEFAULT 0 CHECK (held >= 0),    -- group blocks not yet picked up
  ooo           integer NOT NULL DEFAULT 0 CHECK (ooo >= 0),     -- rooms out of order
  PRIMARY KEY (room_type_id, date),
  CONSTRAINT hotel_no_overbooking CHECK (sold + held + ooo <= total)
);

-- ---------------------------------------------------------------- guests, groups, reservations, stays
CREATE TABLE hotel_guests (
  id                 text PRIMARY KEY,
  org_id             text NOT NULL REFERENCES organisations(id),
  name               text NOT NULL,
  email              text,
  phone              text,
  id_number          text,
  nationality        text,
  vip                boolean NOT NULL DEFAULT false,
  preferences        jsonb NOT NULL DEFAULT '{}',
  allergies          text,
  allergy_consent    boolean NOT NULL DEFAULT false,
  marketing_consent  boolean NOT NULL DEFAULT false,
  notes              text NOT NULL DEFAULT '',
  created_at         timestamptz NOT NULL DEFAULT now(),
  CHECK (allergies IS NULL OR allergy_consent)
);
CREATE INDEX hotel_guests_email ON hotel_guests (org_id, lower(email));
CREATE INDEX hotel_guests_phone ON hotel_guests (org_id, phone);
CREATE INDEX hotel_guests_id_number ON hotel_guests (org_id, id_number);

CREATE TABLE hotel_folios (
  id                    text PRIMARY KEY,
  org_id                text NOT NULL,
  property_id           text NOT NULL REFERENCES hotel_properties(id),
  number                text NOT NULL,
  reservation_id        text,
  stay_id               text,
  group_block_id        text,
  name                  text NOT NULL,
  payer                 text NOT NULL CHECK (payer IN ('guest', 'company')),
  corporate_account_id  text REFERENCES hotel_corporate_accounts(id),
  status                text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  blocked               boolean NOT NULL DEFAULT false,
  blocked_reason        text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  closed_at             timestamptz,
  UNIQUE (org_id, number),
  CHECK ((payer = 'company') = (corporate_account_id IS NOT NULL))
);
CREATE INDEX hotel_folios_stay ON hotel_folios (stay_id);
CREATE INDEX hotel_folios_reservation ON hotel_folios (reservation_id);

CREATE TABLE hotel_group_blocks (
  id                    text PRIMARY KEY,
  org_id                text NOT NULL,
  property_id           text NOT NULL REFERENCES hotel_properties(id),
  name                  text NOT NULL,
  room_type_id          text NOT NULL REFERENCES hotel_room_types(id),
  rate_plan_id          text NOT NULL REFERENCES hotel_rate_plans(id),
  arrival               date NOT NULL,
  departure             date NOT NULL,
  rooms_per_night       integer NOT NULL CHECK (rooms_per_night > 0),
  cutoff_date           date NOT NULL,
  billing               text NOT NULL CHECK (billing IN ('master', 'individual')),
  corporate_account_id  text REFERENCES hotel_corporate_accounts(id),
  status                text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'released')),
  master_folio_id       text REFERENCES hotel_folios(id),
  created_by            text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  CHECK (departure > arrival AND cutoff_date <= arrival)
);

CREATE TABLE hotel_group_block_nights (
  block_id  text NOT NULL REFERENCES hotel_group_blocks(id),
  date      date NOT NULL,
  held      integer NOT NULL CHECK (held >= 0),
  picked    integer NOT NULL DEFAULT 0 CHECK (picked >= 0),
  PRIMARY KEY (block_id, date),
  CHECK (picked <= held)
);

CREATE TABLE hotel_reservations (
  id                    text PRIMARY KEY,
  org_id                text NOT NULL,
  property_id           text NOT NULL REFERENCES hotel_properties(id),
  number                text NOT NULL,
  guest_id              text NOT NULL REFERENCES hotel_guests(id),
  arrival               date NOT NULL,
  departure             date NOT NULL,
  source                text NOT NULL CHECK (source IN ('direct', 'booking_engine', 'phone', 'walk_in', 'channel', 'corporate', 'group')),
  channel_id            text REFERENCES hotel_channels(id),
  external_ref          text,
  corporate_account_id  text REFERENCES hotel_corporate_accounts(id),
  group_block_id        text REFERENCES hotel_group_blocks(id),
  special_requests      text NOT NULL DEFAULT '',
  cancelled_reason      text,
  id_captured           boolean NOT NULL DEFAULT false,
  id_document_ref       text,
  nationality           text,
  signature_ref         text,
  arrival_time          text,
  precheckin_at         timestamptz,
  created_by            text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, number),
  CHECK (departure > arrival),
  CHECK ((source = 'channel') = (channel_id IS NOT NULL)),
  CHECK (precheckin_at IS NULL OR (id_captured AND id_document_ref IS NOT NULL AND signature_ref IS NOT NULL))
);
-- a channel booking is taken once, however often the channel delivers it
CREATE UNIQUE INDEX hotel_reservations_external ON hotel_reservations (channel_id, external_ref) WHERE external_ref IS NOT NULL;
CREATE INDEX hotel_reservations_dates ON hotel_reservations (property_id, arrival, departure);

CREATE TABLE hotel_stays (
  id              text PRIMARY KEY,
  org_id          text NOT NULL,
  property_id     text NOT NULL REFERENCES hotel_properties(id),
  reservation_id  text NOT NULL REFERENCES hotel_reservations(id),
  room_type_id    text NOT NULL REFERENCES hotel_room_types(id),
  rate_plan_id    text NOT NULL REFERENCES hotel_rate_plans(id),
  room_id         text REFERENCES hotel_rooms(id),
  adults          integer NOT NULL CHECK (adults > 0),
  children        integer NOT NULL CHECK (children >= 0),
  arrival         date NOT NULL,
  departure       date NOT NULL,
  status          text NOT NULL CHECK (status IN ('reserved', 'waitlisted', 'in_house', 'checked_out', 'cancelled', 'no_show')),
  from_block      boolean NOT NULL DEFAULT false,
  checked_in_at   timestamptz,
  checked_out_at  timestamptz,
  CHECK (departure > arrival),
  CHECK (status <> 'in_house' OR room_id IS NOT NULL),
  -- a physical room never holds two overlapping stays
  CONSTRAINT hotel_room_not_double_booked EXCLUDE USING gist (room_id WITH =, daterange(arrival, departure) WITH &&)
    WHERE (room_id IS NOT NULL AND status IN ('reserved', 'in_house'))
);
CREATE INDEX hotel_stays_reservation ON hotel_stays (reservation_id);
CREATE INDEX hotel_stays_property_status ON hotel_stays (property_id, status);

-- the price of each night, fixed at booking (rate) next to the rate plan's price (plan_rate) for the income audit
CREATE TABLE hotel_stay_nights (
  stay_id          text NOT NULL REFERENCES hotel_stays(id),
  date             date NOT NULL,
  rate_minor       bigint NOT NULL CHECK (rate_minor > 0),
  plan_rate_minor  bigint NOT NULL CHECK (plan_rate_minor > 0),
  PRIMARY KEY (stay_id, date)
);

CREATE TABLE hotel_folio_routing (
  stay_id     text NOT NULL REFERENCES hotel_stays(id),
  department  text NOT NULL,
  folio_id    text NOT NULL REFERENCES hotel_folios(id),
  PRIMARY KEY (stay_id, department)
);

-- ---------------------------------------------------------------- cashier shifts, folio lines, deposits, refunds
CREATE TABLE hotel_cashier_shifts (
  id                   text PRIMARY KEY,
  org_id               text NOT NULL,
  property_id          text NOT NULL REFERENCES hotel_properties(id),
  user_id              text NOT NULL REFERENCES users(id),
  business_date        date NOT NULL,
  float_minor          bigint NOT NULL CHECK (float_minor >= 0),
  status               text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  counted_cash_minor   bigint,
  expected_cash_minor  bigint,
  over_short_minor     bigint,
  opened_at            timestamptz NOT NULL DEFAULT now(),
  closed_at            timestamptz,
  CHECK ((status = 'closed') = (closed_at IS NOT NULL AND counted_cash_minor IS NOT NULL))
);
CREATE UNIQUE INDEX hotel_one_open_shift ON hotel_cashier_shifts (property_id, user_id) WHERE status = 'open';

CREATE TABLE hotel_folio_lines (
  id                text PRIMARY KEY,
  org_id            text NOT NULL,
  property_id       text NOT NULL REFERENCES hotel_properties(id),
  folio_id          text NOT NULL REFERENCES hotel_folios(id),
  seq               bigint GENERATED ALWAYS AS IDENTITY,
  business_date     date NOT NULL,
  kind              text NOT NULL CHECK (kind IN ('charge', 'payment', 'deposit', 'transfer', 'void', 'refund', 'city_ledger')),
  department        text CHECK (department IN ('rooms', 'fnb', 'spa', 'other', 'noshow')),
  outlet_id         text REFERENCES hotel_outlets(id),
  description       text NOT NULL,
  net_minor         bigint NOT NULL DEFAULT 0,
  service_minor     bigint NOT NULL DEFAULT 0,
  vat_minor         bigint NOT NULL DEFAULT 0,
  levy_minor        bigint NOT NULL DEFAULT 0,
  total_minor       bigint NOT NULL,
  method            text CHECK (method IN ('cash', 'card', 'mobile_money', 'bank_transfer')),
  reference         text,
  shift_id          text REFERENCES hotel_cashier_shifts(id),
  stay_id           text REFERENCES hotel_stays(id),
  night_date        date,                              -- room-night charges: the night charged
  voids_line_id     text UNIQUE REFERENCES hotel_folio_lines(id),
  void_approved_by  text REFERENCES users(id),
  journal_id        text REFERENCES journal_entries(id),
  created_by        text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  CHECK (total_minor = net_minor + service_minor + vat_minor + levy_minor),
  CHECK ((method IS NOT NULL) = (kind IN ('payment', 'refund', 'deposit'))),
  CHECK ((kind = 'void') = (voids_line_id IS NOT NULL)),
  CHECK (kind <> 'charge' OR (department IS NOT NULL AND total_minor > 0))
);
CREATE INDEX hotel_folio_lines_folio ON hotel_folio_lines (folio_id, seq);
CREATE INDEX hotel_folio_lines_date ON hotel_folio_lines (property_id, business_date);
-- the night audit charges each room night once
CREATE UNIQUE INDEX hotel_room_night_once ON hotel_folio_lines (stay_id, night_date)
  WHERE kind = 'charge' AND night_date IS NOT NULL;

CREATE TABLE hotel_deposits (
  id               text PRIMARY KEY,
  org_id           text NOT NULL,
  property_id      text NOT NULL REFERENCES hotel_properties(id),
  reservation_id   text NOT NULL REFERENCES hotel_reservations(id),
  amount_minor     bigint NOT NULL CHECK (amount_minor > 0),
  method           text NOT NULL CHECK (method IN ('cash', 'card', 'mobile_money', 'bank_transfer')),
  reference        text NOT NULL,
  received_date    date NOT NULL,
  journal_id       text NOT NULL REFERENCES journal_entries(id),
  applied_folio_id text REFERENCES hotel_folios(id),
  applied_at       timestamptz,
  created_by       text
);

CREATE TABLE hotel_refunds (
  id            text PRIMARY KEY,
  org_id        text NOT NULL,
  property_id   text NOT NULL REFERENCES hotel_properties(id),
  folio_id      text NOT NULL REFERENCES hotel_folios(id),
  amount_minor  bigint NOT NULL CHECK (amount_minor > 0),
  method        text NOT NULL CHECK (method IN ('cash', 'card', 'mobile_money', 'bank_transfer')),
  reason        text NOT NULL,
  status        text NOT NULL DEFAULT 'requested' CHECK (status IN ('requested', 'approved')),
  requested_by  text NOT NULL REFERENCES users(id),
  approved_by   text REFERENCES users(id),
  line_id       text REFERENCES hotel_folio_lines(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT hotel_refund_second_person CHECK (approved_by IS NULL OR approved_by <> requested_by),
  CHECK ((status = 'approved') = (approved_by IS NOT NULL AND line_id IS NOT NULL))
);

-- company / travel-agent receivables after check-out (city ledger); payments reduce them
CREATE TABLE hotel_city_ledger (
  id                    text PRIMARY KEY,
  org_id                text NOT NULL,
  property_id           text NOT NULL REFERENCES hotel_properties(id),
  account_id            text NOT NULL REFERENCES hotel_corporate_accounts(id),
  number                text NOT NULL,
  kind                  text NOT NULL CHECK (kind IN ('invoice', 'payment')),
  date                  date NOT NULL,
  amount_minor          bigint NOT NULL CHECK (amount_minor > 0),
  folio_id              text REFERENCES hotel_folios(id),
  reference             text NOT NULL DEFAULT '',
  journal_id            text NOT NULL REFERENCES journal_entries(id),
  created_by            text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, number)
);
CREATE INDEX hotel_city_ledger_account ON hotel_city_ledger (account_id, date);

-- which hotel and business date each automatic hotel journal belongs to (reports read the ledger through this)
CREATE TABLE hotel_ledger_links (
  journal_id     text PRIMARY KEY REFERENCES journal_entries(id),
  org_id         text NOT NULL,
  property_id    text NOT NULL REFERENCES hotel_properties(id),
  business_date  date NOT NULL,
  kind           text NOT NULL,
  channel_id     text REFERENCES hotel_channels(id)
);
CREATE INDEX hotel_ledger_links_property ON hotel_ledger_links (property_id, business_date);

-- ---------------------------------------------------------------- rooms operations
CREATE TABLE hotel_hk_assignments (
  room_id            text NOT NULL REFERENCES hotel_rooms(id),
  date               date NOT NULL,
  org_id             text NOT NULL,
  property_id        text NOT NULL REFERENCES hotel_properties(id),
  attendant_user_id  text NOT NULL REFERENCES users(id),
  PRIMARY KEY (room_id, date)
);

CREATE TABLE hotel_maintenance (
  id           text PRIMARY KEY,
  org_id       text NOT NULL,
  property_id  text NOT NULL REFERENCES hotel_properties(id),
  room_id      text REFERENCES hotel_rooms(id),
  title        text NOT NULL,
  kind         text NOT NULL CHECK (kind IN ('corrective', 'preventive')),
  priority     text NOT NULL CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
  status       text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
  ooo_from     date,
  ooo_to       date,
  out_of_service  boolean NOT NULL DEFAULT false,
  due_date     date,
  note         text NOT NULL DEFAULT '',
  created_by   text,
  resolved_by  text,
  resolved_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CHECK ((ooo_from IS NULL) = (ooo_to IS NULL) AND (ooo_to IS NULL OR ooo_to >= ooo_from))
);

CREATE TABLE hotel_lost_found (
  id               text PRIMARY KEY,
  org_id           text NOT NULL,
  property_id      text NOT NULL REFERENCES hotel_properties(id),
  room_id          text REFERENCES hotel_rooms(id),
  item             text NOT NULL,
  found_on         date NOT NULL,
  photo_ref        text,
  guest_contacted  boolean NOT NULL DEFAULT false,
  status           text NOT NULL DEFAULT 'held' CHECK (status IN ('held', 'returned', 'disposed')),
  created_by       text,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE hotel_requests (
  id              text PRIMARY KEY,
  org_id          text NOT NULL,
  property_id     text NOT NULL REFERENCES hotel_properties(id),
  stay_id         text REFERENCES hotel_stays(id),
  reservation_id  text REFERENCES hotel_reservations(id),
  kind            text NOT NULL CHECK (kind IN ('request', 'wake_up', 'housekeeping', 'maintenance', 'handoff')),
  text            text NOT NULL,
  due_at          timestamptz,
  status          text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done')),
  source          text NOT NULL CHECK (source IN ('staff', 'concierge', 'guest')),
  created_by      text,
  completed_by    text,
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------- audits and reports
CREATE TABLE hotel_night_audits (
  id             text PRIMARY KEY,
  org_id         text NOT NULL,
  property_id    text NOT NULL REFERENCES hotel_properties(id),
  business_date  date NOT NULL,
  status         text NOT NULL CHECK (status IN ('completed', 'blocked')),
  blocks         jsonb NOT NULL DEFAULT '[]',
  run_by         text,
  run_at         timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX hotel_night_audit_once ON hotel_night_audits (property_id, business_date) WHERE status = 'completed';

CREATE TABLE hotel_daily_reports (
  property_id    text NOT NULL REFERENCES hotel_properties(id),
  business_date  date NOT NULL,
  org_id         text NOT NULL,
  report         jsonb NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (property_id, business_date)
);

CREATE TABLE hotel_income_audits (
  property_id    text NOT NULL REFERENCES hotel_properties(id),
  business_date  date NOT NULL,
  org_id         text NOT NULL,
  night_audit_by text,
  signed_off_by  text REFERENCES users(id),
  signed_off_at  timestamptz,
  note           text,
  findings       jsonb,                               -- the findings acknowledged at sign-off
  PRIMARY KEY (property_id, business_date),
  CONSTRAINT hotel_income_audit_second_person CHECK (signed_off_by IS NULL OR signed_off_by IS DISTINCT FROM night_audit_by)
);

-- ---------------------------------------------------------------- integration boundaries (recorded; test adapters)
CREATE TABLE hotel_keys (
  id           text PRIMARY KEY,
  org_id       text NOT NULL,
  property_id  text NOT NULL REFERENCES hotel_properties(id),
  stay_id      text NOT NULL REFERENCES hotel_stays(id),
  room_id      text NOT NULL REFERENCES hotel_rooms(id),
  valid_from   date NOT NULL,
  valid_to     date NOT NULL,
  status       text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  adapter      text NOT NULL,
  adapter_ref  text NOT NULL,
  issued_at    timestamptz NOT NULL DEFAULT now(),
  revoked_at   timestamptz,
  CHECK ((status = 'revoked') = (revoked_at IS NOT NULL))
);
CREATE INDEX hotel_keys_stay ON hotel_keys (stay_id);

CREATE TABLE hotel_room_commands (
  seq           bigint GENERATED ALWAYS AS IDENTITY,
  id           text PRIMARY KEY,
  org_id       text NOT NULL,
  property_id  text NOT NULL REFERENCES hotel_properties(id),
  room_id      text NOT NULL REFERENCES hotel_rooms(id),
  command      text NOT NULL CHECK (command IN ('eco_on', 'eco_off', 'set_temperature')),
  value        numeric(4,1),
  reason       text NOT NULL,
  adapter      text NOT NULL,
  status       text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX hotel_room_commands_property ON hotel_room_commands (property_id, seq);

CREATE TABLE hotel_ari_outbox (
  seq           bigint GENERATED ALWAYS AS IDENTITY,
  id            text PRIMARY KEY,
  org_id        text NOT NULL,
  property_id   text NOT NULL REFERENCES hotel_properties(id),
  channel_id    text NOT NULL REFERENCES hotel_channels(id),
  room_type_id  text NOT NULL REFERENCES hotel_room_types(id),
  date_from     date NOT NULL,
  date_to       date NOT NULL,
  payload       jsonb NOT NULL,
  status        text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX hotel_ari_outbox_property ON hotel_ari_outbox (property_id, seq);

CREATE TABLE hotel_messages (
  seq           bigint GENERATED ALWAYS AS IDENTITY,
  id              text PRIMARY KEY,
  org_id          text NOT NULL,
  property_id     text NOT NULL REFERENCES hotel_properties(id),
  reservation_id  text REFERENCES hotel_reservations(id),
  channel         text NOT NULL CHECK (channel IN ('whatsapp', 'sms', 'email', 'web')),
  direction       text NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  body            text NOT NULL,
  status          text NOT NULL,
  created_by      text,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX hotel_messages_property ON hotel_messages (property_id, seq);
