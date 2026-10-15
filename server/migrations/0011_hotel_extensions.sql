-- Smart Hotel extensions (builds on 0005_hotel). Same rules: every table carries org_id; money is bigint minor units
-- in the organisation's currency; percentages are basis points (1 % = 100); stock quantities are thousandths of a
-- unit (qty_milli) so recipes can use 0.2 of a bottle while staying integer. Money posts to the ONE ledger through
-- the ledger service (hotel_ledger_links ties each journal to its hotel and business date).
-- Invariants the database itself enforces here:
--   * a void, an allowance (comp / discount), a purchase order, a supplier-bill override and a pay run are approved by
--     someone other than the person who made them;
--   * a therapist / guide, a treatment room and an event venue are never booked twice for overlapping times;
--   * stock on hand and its value never go negative; loyalty points never go negative;
--   * an issued invoice is never edited or deleted (only cancelled by a credit note);
--   * a payment is matched to the bank once; a room night is still charged once.

-- ---------------------------------------------------------------- property settings for the extensions
ALTER TABLE hotel_properties
  ADD COLUMN auto_audit_enabled    boolean NOT NULL DEFAULT false,
  ADD COLUMN auto_audit_time       text NOT NULL DEFAULT '02:00' CHECK (auto_audit_time ~ '^([01]\d|2[0-3]):[0-5]\d$'),
  ADD COLUMN auto_audit_no_shows   boolean NOT NULL DEFAULT true,
  ADD COLUMN pre_arrival_days      integer NOT NULL DEFAULT 2 CHECK (pre_arrival_days BETWEEN 0 AND 30),
  ADD COLUMN ffe_reserve_bp        integer NOT NULL DEFAULT 400 CHECK (ffe_reserve_bp BETWEEN 0 AND 10000),
  ADD COLUMN carbon_g_per_kwh      integer NOT NULL DEFAULT 0 CHECK (carbon_g_per_kwh BETWEEN 0 AND 5000),
  ADD COLUMN linen_change_nights   integer NOT NULL DEFAULT 3 CHECK (linen_change_nights BETWEEN 1 AND 30),
  ADD COLUMN overtime_bp           integer NOT NULL DEFAULT 15000 CHECK (overtime_bp BETWEEN 10000 AND 30000),
  ADD COLUMN standard_day_hours    integer NOT NULL DEFAULT 8 CHECK (standard_day_hours BETWEEN 1 AND 24),
  ADD COLUMN legal_name            text NOT NULL DEFAULT '',
  ADD COLUMN tax_id                text NOT NULL DEFAULT '',
  ADD COLUMN address               text NOT NULL DEFAULT '';

-- the payroll accounts join the departmental P&L of hotels created before this migration
UPDATE hotel_properties SET usali = jsonb_set(usali, '{rooms,costs}', (usali #> '{rooms,costs}') || '["5150"]')
  WHERE NOT (usali #> '{rooms,costs}') ? '5150';
UPDATE hotel_properties SET usali = jsonb_set(usali, '{fnb,costs}', (usali #> '{fnb,costs}') || '["5250"]')
  WHERE NOT (usali #> '{fnb,costs}') ? '5250';
UPDATE hotel_properties SET usali = jsonb_set(usali, '{spa,costs}', (usali #> '{spa,costs}') || '["5350"]')
  WHERE NOT (usali #> '{spa,costs}') ? '5350';
UPDATE hotel_properties SET usali = jsonb_set(usali, '{other,costs}', (usali #> '{other,costs}') || '["5450"]')
  WHERE NOT (usali #> '{other,costs}') ? '5450';
UPDATE hotel_properties SET usali = jsonb_set(usali, '{undistributed,costs}', (usali #> '{undistributed,costs}') || '["5950", "5700"]')
  WHERE NOT (usali #> '{undistributed,costs}') ? '5950';

-- the extension accounts for organisations that subscribed to Hotel before this migration (new ones get them from
-- the product's account list when they subscribe)
INSERT INTO ledger_accounts (org_id, code, name, type, system)
SELECT s.org_id, a.code, a.name, a.type, true
FROM subscriptions s
CROSS JOIN (VALUES
  ('1020', 'FF&E replacement reserve fund', 'asset'),
  ('1300', 'Inventory — food, beverage, linen and amenities', 'asset'),
  ('1500', 'Fixed assets — furniture, fixtures and equipment', 'asset'),
  ('1590', 'Accumulated depreciation', 'asset'),
  ('2010', 'Goods received not invoiced', 'liability'),
  ('2130', 'Tips payable to staff', 'liability'),
  ('2200', 'Wages payable', 'liability'),
  ('2400', 'Loyalty points liability', 'liability'),
  ('4900', 'Gain on disposal of assets', 'income'),
  ('5150', 'Rooms payroll', 'expense'),
  ('5250', 'Food and beverage payroll', 'expense'),
  ('5350', 'Spa and activities payroll', 'expense'),
  ('5450', 'Other departments payroll', 'expense'),
  ('5700', 'Loyalty programme cost', 'expense'),
  ('5950', 'Administrative and general payroll', 'expense'),
  ('6100', 'Depreciation', 'expense'),
  ('6150', 'Loss on disposal of assets', 'expense')
) AS a(code, name, type)
WHERE s.product = 'hotel'
ON CONFLICT (org_id, code) DO NOTHING;

-- ---------------------------------------------------------------- folio lines: allowances (comps, discounts) and loyalty
DO $$
DECLARE c text;
BEGIN
  SELECT conname INTO c FROM pg_constraint
   WHERE conrelid = 'hotel_folio_lines'::regclass AND contype = 'c'
     AND pg_get_constraintdef(oid) LIKE '%''city_ledger''%' AND pg_get_constraintdef(oid) NOT LIKE '%method%';
  EXECUTE format('ALTER TABLE hotel_folio_lines DROP CONSTRAINT %I', c);
END $$;
ALTER TABLE hotel_folio_lines
  ADD CONSTRAINT hotel_folio_line_kind CHECK (kind IN ('charge', 'payment', 'deposit', 'transfer', 'void', 'refund',
    'city_ledger', 'allowance', 'loyalty')),
  ADD COLUMN allowance_kind          text CHECK (allowance_kind IN ('comp', 'discount')),
  ADD COLUMN allowance_of_line_id    text REFERENCES hotel_folio_lines(id),
  ADD COLUMN allowance_approved_by   text REFERENCES users(id),
  ADD CONSTRAINT hotel_allowance_shape CHECK ((kind = 'allowance') = (allowance_kind IS NOT NULL AND allowance_of_line_id IS NOT NULL)),
  ADD CONSTRAINT hotel_allowance_second_person CHECK (allowance_approved_by IS NULL OR allowance_approved_by IS DISTINCT FROM created_by),
  ADD CONSTRAINT hotel_void_second_person CHECK (void_approved_by IS NULL OR void_approved_by IS DISTINCT FROM created_by);
CREATE INDEX hotel_folio_lines_allowance ON hotel_folio_lines (allowance_of_line_id) WHERE allowance_of_line_id IS NOT NULL;

-- ---------------------------------------------------------------- reservations: booking engine, attributes, pace
ALTER TABLE hotel_guests ADD COLUMN language text NOT NULL DEFAULT 'en';
-- the guest's entry in the organisation's ONE contact store (core/contacts); a contact merge moves this reference
ALTER TABLE hotel_guests ADD COLUMN contact_id text REFERENCES contacts(id);
CREATE INDEX hotel_guests_contact ON hotel_guests (contact_id) WHERE contact_id IS NOT NULL;
ALTER TABLE hotel_corporate_accounts
  ADD COLUMN tax_id             text,
  ADD COLUMN billing_address    text,
  ADD COLUMN payment_terms_days integer NOT NULL DEFAULT 30 CHECK (payment_terms_days BETWEEN 0 AND 365);

CREATE TABLE hotel_promo_codes (
  id             text PRIMARY KEY,
  org_id         text NOT NULL,
  property_id    text NOT NULL REFERENCES hotel_properties(id),
  code           text NOT NULL,
  description    text NOT NULL DEFAULT '',
  discount_bp    integer NOT NULL CHECK (discount_bp BETWEEN 1 AND 10000),
  stay_from      date,
  stay_to        date,
  min_nights     integer NOT NULL DEFAULT 1 CHECK (min_nights >= 1),
  max_uses       integer CHECK (max_uses > 0),
  uses           integer NOT NULL DEFAULT 0 CHECK (uses >= 0),
  rate_plan_ids  text[] NOT NULL DEFAULT '{}',        -- empty = every plan
  active         boolean NOT NULL DEFAULT true,
  created_by     text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CHECK (max_uses IS NULL OR uses <= max_uses),
  CHECK (stay_to IS NULL OR stay_from IS NULL OR stay_to >= stay_from)
);
CREATE UNIQUE INDEX hotel_promo_codes_code ON hotel_promo_codes (property_id, upper(code));

CREATE TABLE hotel_upsells (
  id            text PRIMARY KEY,
  org_id        text NOT NULL,
  property_id   text NOT NULL REFERENCES hotel_properties(id),
  code          text NOT NULL,
  name          text NOT NULL,
  department    text NOT NULL CHECK (department IN ('rooms', 'fnb', 'spa', 'other')),
  pricing       text NOT NULL CHECK (pricing IN ('per_stay', 'per_night', 'per_adult_night')),
  amount_minor  bigint NOT NULL CHECK (amount_minor > 0),
  active        boolean NOT NULL DEFAULT true,
  UNIQUE (property_id, code)
);

-- room features sold for a price per night (attribute-based selling): high floor, sea view, bathtub, connecting …
CREATE TABLE hotel_attribute_prices (
  property_id   text NOT NULL REFERENCES hotel_properties(id),
  attribute     text NOT NULL,
  org_id        text NOT NULL,
  name          text NOT NULL,
  amount_minor  bigint NOT NULL CHECK (amount_minor >= 0),
  PRIMARY KEY (property_id, attribute)
);

ALTER TABLE hotel_reservations
  ADD COLUMN promo_code_id  text REFERENCES hotel_promo_codes(id),
  ADD COLUMN linen_reuse    boolean NOT NULL DEFAULT false;

ALTER TABLE hotel_stays
  ADD COLUMN requested_attributes  text[] NOT NULL DEFAULT '{}',
  ADD COLUMN attribute_fee_minor   bigint NOT NULL DEFAULT 0 CHECK (attribute_fee_minor >= 0),
  ADD COLUMN cancelled_at          timestamptz;

-- why a night is priced below its rate plan when that is a sanctioned discount (promo code, member rate, RFP)
ALTER TABLE hotel_stay_nights
  ADD COLUMN discount_kind  text CHECK (discount_kind IN ('promo', 'member')),
  ADD COLUMN discount_ref   text,
  ADD CONSTRAINT hotel_night_discount_shape CHECK ((discount_kind IS NULL) = (discount_ref IS NULL));

-- extras booked with the reservation, charged to the guest folio at check-in
CREATE TABLE hotel_reservation_upsells (
  id              text PRIMARY KEY,
  org_id          text NOT NULL,
  property_id     text NOT NULL REFERENCES hotel_properties(id),
  reservation_id  text NOT NULL REFERENCES hotel_reservations(id),
  upsell_id       text NOT NULL REFERENCES hotel_upsells(id),
  description     text NOT NULL,
  department      text NOT NULL CHECK (department IN ('rooms', 'fnb', 'spa', 'other')),
  amount_minor    bigint NOT NULL CHECK (amount_minor > 0),
  line_id         text REFERENCES hotel_folio_lines(id),
  status          text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'posted', 'cancelled')),
  CHECK ((status = 'posted') = (line_id IS NOT NULL))
);
CREATE INDEX hotel_reservation_upsells_res ON hotel_reservation_upsells (reservation_id);

-- ---------------------------------------------------------------- loyalty (one programme per organisation: chain-wide)
CREATE TABLE hotel_loyalty_programmes (
  org_id                 text PRIMARY KEY REFERENCES organisations(id),
  name                   text NOT NULL,
  minor_per_point        bigint NOT NULL CHECK (minor_per_point > 0),   -- room revenue that earns one point
  point_value_minor      bigint NOT NULL CHECK (point_value_minor > 0), -- what a point is worth when redeemed
  tiers                  jsonb NOT NULL,
  updated_at             timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE hotel_loyalty_members (
  id               text PRIMARY KEY,
  org_id           text NOT NULL REFERENCES organisations(id),
  guest_id         text NOT NULL UNIQUE REFERENCES hotel_guests(id),
  number           text NOT NULL,
  tier             text NOT NULL,
  points           bigint NOT NULL DEFAULT 0 CHECK (points >= 0),
  lifetime_points  bigint NOT NULL DEFAULT 0 CHECK (lifetime_points >= 0),
  stays            integer NOT NULL DEFAULT 0 CHECK (stays >= 0),
  joined_on        date NOT NULL,
  UNIQUE (org_id, number)
);

CREATE TABLE hotel_loyalty_entries (
  seq             bigint GENERATED ALWAYS AS IDENTITY,
  id              text PRIMARY KEY,
  org_id          text NOT NULL,
  member_id       text NOT NULL REFERENCES hotel_loyalty_members(id),
  property_id     text NOT NULL REFERENCES hotel_properties(id),
  kind            text NOT NULL CHECK (kind IN ('earn', 'redeem', 'adjust', 'reverse')),
  points          bigint NOT NULL CHECK (points <> 0),
  value_minor     bigint NOT NULL,
  reservation_id  text REFERENCES hotel_reservations(id),
  line_id         text REFERENCES hotel_folio_lines(id),   -- a redemption applied to a folio
  journal_id      text REFERENCES journal_entries(id),
  status          text NOT NULL DEFAULT 'done' CHECK (status IN ('pending', 'done', 'reversed')),
  note            text NOT NULL DEFAULT '',
  created_by      text,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX hotel_loyalty_entries_member ON hotel_loyalty_entries (member_id, seq);
-- points are earned once per stay (reservation)
CREATE UNIQUE INDEX hotel_loyalty_earn_once ON hotel_loyalty_entries (member_id, reservation_id) WHERE kind = 'earn';

-- ---------------------------------------------------------------- guest feedback (internal surveys)
CREATE TABLE hotel_feedback (
  id                text PRIMARY KEY,
  org_id            text NOT NULL,
  property_id       text NOT NULL REFERENCES hotel_properties(id),
  reservation_id    text NOT NULL UNIQUE REFERENCES hotel_reservations(id),
  guest_id          text NOT NULL REFERENCES hotel_guests(id),
  score             integer NOT NULL CHECK (score BETWEEN 1 AND 5),
  categories        jsonb NOT NULL DEFAULT '{}',
  comment           text NOT NULL DEFAULT '',
  source            text NOT NULL CHECK (source IN ('survey', 'staff', 'email', 'other')),
  business_date     date NOT NULL,
  alert_request_id  text REFERENCES hotel_requests(id),
  created_by        text,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX hotel_feedback_property ON hotel_feedback (property_id, business_date);

-- ---------------------------------------------------------------- messages: the hotel's outbox (recorded, never sent here)
ALTER TABLE hotel_messages
  ADD COLUMN template         text,
  ADD COLUMN recipient        text,
  ADD COLUMN subject          text,
  ADD COLUMN notification_id  text;   -- the platform outbox message (core notifications) a templated message became
-- automatic guest messages are recorded once per reservation
CREATE UNIQUE INDEX hotel_messages_auto_once ON hotel_messages (reservation_id, template)
  WHERE template IN ('confirmation', 'pre_arrival', 'post_stay_survey');

CREATE TABLE hotel_message_templates (
  property_id  text NOT NULL REFERENCES hotel_properties(id),
  template     text NOT NULL,
  language     text NOT NULL,
  org_id       text NOT NULL,
  subject      text NOT NULL,
  body         text NOT NULL,
  updated_by   text,
  PRIMARY KEY (property_id, template, language)
);

-- ---------------------------------------------------------------- multi-currency: the day's rate, entered by staff
CREATE TABLE hotel_fx_rates (
  property_id  text NOT NULL REFERENCES hotel_properties(id),
  date         date NOT NULL,
  currency     text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  org_id       text NOT NULL,
  rate_micro   bigint NOT NULL CHECK (rate_micro > 0),        -- hotel currency per 1 foreign unit × 1,000,000
  entered_by   text,
  entered_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (property_id, date, currency)
);

CREATE TABLE hotel_fx_payments (
  line_id        text PRIMARY KEY REFERENCES hotel_folio_lines(id),
  org_id         text NOT NULL,
  currency       text NOT NULL,
  foreign_minor  bigint NOT NULL CHECK (foreign_minor > 0),
  rate_micro     bigint NOT NULL CHECK (rate_micro > 0),
  rate_date      date NOT NULL
);

-- ---------------------------------------------------------------- tax invoices and credit notes (sequential numbers)
CREATE TABLE hotel_invoices (
  id                    text PRIMARY KEY,
  org_id                text NOT NULL,
  property_id           text NOT NULL REFERENCES hotel_properties(id),
  number                text NOT NULL,
  kind                  text NOT NULL CHECK (kind IN ('invoice', 'credit_note')),
  folio_id              text NOT NULL REFERENCES hotel_folios(id),
  corporate_account_id  text REFERENCES hotel_corporate_accounts(id),
  credits_invoice_id    text REFERENCES hotel_invoices(id),
  cancelled_by_id       text REFERENCES hotel_invoices(id),
  issued_on             date NOT NULL,
  document              jsonb NOT NULL,
  total_minor           bigint NOT NULL,
  einvoice_status       text NOT NULL DEFAULT 'not submitted',
  einvoice_ref          text,
  issued_by             text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, number),
  CHECK ((kind = 'credit_note') = (credits_invoice_id IS NOT NULL)),
  CHECK (kind = 'invoice' OR cancelled_by_id IS NULL)
);
-- one live invoice per folio; one credit note per invoice
CREATE UNIQUE INDEX hotel_invoice_per_folio ON hotel_invoices (folio_id) WHERE kind = 'invoice' AND cancelled_by_id IS NULL;
CREATE UNIQUE INDEX hotel_credit_note_once ON hotel_invoices (credits_invoice_id) WHERE kind = 'credit_note';

CREATE FUNCTION hotel_invoice_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'An issued invoice cannot be deleted — issue a credit note' USING ERRCODE = 'PA003';
  END IF;
  IF NEW.number IS DISTINCT FROM OLD.number OR NEW.kind IS DISTINCT FROM OLD.kind OR NEW.folio_id IS DISTINCT FROM OLD.folio_id
     OR NEW.document IS DISTINCT FROM OLD.document OR NEW.total_minor IS DISTINCT FROM OLD.total_minor
     OR NEW.issued_on IS DISTINCT FROM OLD.issued_on OR NEW.credits_invoice_id IS DISTINCT FROM OLD.credits_invoice_id
     OR (OLD.cancelled_by_id IS NOT NULL AND NEW.cancelled_by_id IS DISTINCT FROM OLD.cancelled_by_id) THEN
    RAISE EXCEPTION 'An issued invoice cannot be changed — issue a credit note' USING ERRCODE = 'PA003';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER hotel_invoice_immutable BEFORE UPDATE OR DELETE ON hotel_invoices
  FOR EACH ROW EXECUTE FUNCTION hotel_invoice_immutable();

-- ---------------------------------------------------------------- city-ledger collections
-- company payments keep their method and the bank reference on its own, for reconciliation
ALTER TABLE hotel_city_ledger
  ADD COLUMN method          text CHECK (method IN ('cash', 'card', 'mobile_money', 'bank_transfer')),
  ADD COLUMN bank_reference  text;

CREATE TABLE hotel_collection_actions (
  id                text PRIMARY KEY,
  org_id            text NOT NULL,
  account_id        text NOT NULL REFERENCES hotel_corporate_accounts(id),
  kind              text NOT NULL CHECK (kind IN ('reminder', 'call', 'promise', 'note', 'statement_sent')),
  note              text NOT NULL,
  promised_date     date,
  promised_minor    bigint CHECK (promised_minor > 0),
  next_action_date  date,
  message_id        text REFERENCES hotel_messages(id),
  created_by        text,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX hotel_collection_actions_account ON hotel_collection_actions (account_id, created_at);

-- ---------------------------------------------------------------- card and payment reconciliation to the bank
CREATE TABLE hotel_bank_imports (
  id             text PRIMARY KEY,
  org_id         text NOT NULL,
  property_id    text NOT NULL REFERENCES hotel_properties(id),
  statement_ref  text NOT NULL,
  imported_by    text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (property_id, statement_ref)
);

CREATE TABLE hotel_bank_lines (
  id             text PRIMARY KEY,
  org_id         text NOT NULL,
  property_id    text NOT NULL REFERENCES hotel_properties(id),
  import_id      text NOT NULL REFERENCES hotel_bank_imports(id),
  date           date NOT NULL,
  amount_minor   bigint NOT NULL CHECK (amount_minor <> 0),
  reference      text NOT NULL,
  description    text NOT NULL DEFAULT '',
  status         text NOT NULL DEFAULT 'unmatched' CHECK (status IN ('unmatched', 'matched', 'chargeback')),
  fee_minor      bigint NOT NULL DEFAULT 0 CHECK (fee_minor >= 0),
  fee_journal_id text REFERENCES journal_entries(id),
  journal_id     text REFERENCES journal_entries(id),     -- chargeback posting
  chargeback_source text,                                 -- the recorded payment a chargeback reverses
  matched_by     text,
  matched_at     timestamptz
);
CREATE INDEX hotel_bank_lines_property ON hotel_bank_lines (property_id, status, date);

-- a recorded payment (folio payment, deposit, company payment, event deposit) is matched to the bank once
CREATE TABLE hotel_bank_matches (
  source        text PRIMARY KEY,                          -- "line:<id>", "deposit:<id>", "cl:<id>", "evdep:<id>"
  bank_line_id  text NOT NULL REFERENCES hotel_bank_lines(id),
  org_id        text NOT NULL,
  amount_minor  bigint NOT NULL CHECK (amount_minor > 0)
);
CREATE INDEX hotel_bank_matches_line ON hotel_bank_matches (bank_line_id);

-- ---------------------------------------------------------------- outlets: menus, orders, kitchen, tables, tips
ALTER TABLE hotel_outlets
  ADD COLUMN seats         integer NOT NULL DEFAULT 0 CHECK (seats >= 0),
  ADD COLUMN slot_minutes  integer NOT NULL DEFAULT 120 CHECK (slot_minutes BETWEEN 15 AND 480);

CREATE TABLE hotel_menu_items (
  id           text PRIMARY KEY,
  org_id       text NOT NULL,
  property_id  text NOT NULL REFERENCES hotel_properties(id),
  outlet_id    text NOT NULL REFERENCES hotel_outlets(id),
  code         text NOT NULL,
  name         text NOT NULL,
  category     text NOT NULL DEFAULT '',
  price_minor  bigint NOT NULL CHECK (price_minor > 0),
  modifiers    jsonb NOT NULL DEFAULT '[]',               -- [{ code, name, priceMinor }]
  active       boolean NOT NULL DEFAULT true,
  UNIQUE (outlet_id, code)
);

CREATE TABLE hotel_pos_orders (
  id             text PRIMARY KEY,
  org_id         text NOT NULL,
  property_id    text NOT NULL REFERENCES hotel_properties(id),
  outlet_id      text NOT NULL REFERENCES hotel_outlets(id),
  number         text NOT NULL,
  table_no       text,
  covers         integer NOT NULL DEFAULT 1 CHECK (covers > 0),
  status         text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'settled', 'cancelled')),
  settled_mode   text CHECK (settled_mode IN ('room', 'paid')),
  folio_id       text REFERENCES hotel_folios(id),
  business_date  date NOT NULL,
  cancel_reason  text,
  created_by     text,
  settled_by     text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, number),
  CHECK ((status = 'settled') = (settled_mode IS NOT NULL AND folio_id IS NOT NULL))
);
CREATE INDEX hotel_pos_orders_outlet ON hotel_pos_orders (outlet_id, status);

CREATE TABLE hotel_pos_order_lines (
  seq           bigint GENERATED ALWAYS AS IDENTITY,
  id            text PRIMARY KEY,
  order_id      text NOT NULL REFERENCES hotel_pos_orders(id),
  menu_item_id  text NOT NULL REFERENCES hotel_menu_items(id),
  name          text NOT NULL,
  quantity      integer NOT NULL CHECK (quantity > 0),
  modifiers     jsonb NOT NULL DEFAULT '[]',
  unit_minor    bigint NOT NULL CHECK (unit_minor > 0),
  net_minor     bigint NOT NULL CHECK (net_minor > 0),
  note          text NOT NULL DEFAULT '',
  CHECK (net_minor = unit_minor * quantity)
);
CREATE INDEX hotel_pos_order_lines_order ON hotel_pos_order_lines (order_id, seq);

CREATE TABLE hotel_kitchen_tickets (
  seq          bigint GENERATED ALWAYS AS IDENTITY,
  id           text PRIMARY KEY,
  org_id       text NOT NULL,
  property_id  text NOT NULL REFERENCES hotel_properties(id),
  outlet_id    text NOT NULL REFERENCES hotel_outlets(id),
  order_id     text NOT NULL REFERENCES hotel_pos_orders(id),
  number       text NOT NULL,
  items        jsonb NOT NULL,
  status       text NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'preparing', 'ready', 'served', 'cancelled')),
  printer      text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX hotel_kitchen_tickets_outlet ON hotel_kitchen_tickets (outlet_id, status, seq);

CREATE TABLE hotel_tips (
  id               text PRIMARY KEY,
  org_id           text NOT NULL,
  property_id      text NOT NULL REFERENCES hotel_properties(id),
  outlet_id        text REFERENCES hotel_outlets(id),
  order_id         text REFERENCES hotel_pos_orders(id),
  amount_minor     bigint NOT NULL CHECK (amount_minor > 0),
  method           text NOT NULL CHECK (method IN ('cash', 'card', 'mobile_money', 'bank_transfer')),
  reference        text NOT NULL,
  shift_id         text REFERENCES hotel_cashier_shifts(id),
  business_date    date NOT NULL,
  journal_id       text NOT NULL REFERENCES journal_entries(id),
  created_by       text,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX hotel_tips_shift ON hotel_tips (shift_id);

CREATE TABLE hotel_table_bookings (
  id           text PRIMARY KEY,
  org_id       text NOT NULL,
  property_id  text NOT NULL REFERENCES hotel_properties(id),
  outlet_id    text NOT NULL REFERENCES hotel_outlets(id),
  name         text NOT NULL,
  stay_id      text REFERENCES hotel_stays(id),
  date         date NOT NULL,
  time         text NOT NULL,
  starts_at    timestamp NOT NULL,
  ends_at      timestamp NOT NULL,
  covers       integer NOT NULL CHECK (covers > 0),
  source       text NOT NULL CHECK (source IN ('phone', 'website', 'in_house', 'walk_in', 'booking_engine')),
  status       text NOT NULL DEFAULT 'booked' CHECK (status IN ('booked', 'seated', 'completed', 'cancelled', 'no_show')),
  notes        text NOT NULL DEFAULT '',
  created_by   text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at)
);
CREATE INDEX hotel_table_bookings_outlet ON hotel_table_bookings (outlet_id, date);

-- ---------------------------------------------------------------- stock, recipes, purchase orders, supplier bills
CREATE TABLE hotel_stock_items (
  id              text PRIMARY KEY,
  org_id          text NOT NULL,
  property_id     text NOT NULL REFERENCES hotel_properties(id),
  code            text NOT NULL,
  name            text NOT NULL,
  category        text NOT NULL CHECK (category IN ('food', 'beverage', 'linen', 'amenity', 'cleaning', 'other')),
  unit            text NOT NULL,
  par_milli       bigint NOT NULL DEFAULT 0 CHECK (par_milli >= 0),
  reorder_milli   bigint NOT NULL DEFAULT 0 CHECK (reorder_milli >= 0),
  qty_milli       bigint NOT NULL DEFAULT 0 CHECK (qty_milli >= 0),
  value_minor     bigint NOT NULL DEFAULT 0 CHECK (value_minor >= 0),
  active          boolean NOT NULL DEFAULT true,
  UNIQUE (property_id, code),
  CHECK (qty_milli > 0 OR value_minor = 0)
);

CREATE TABLE hotel_stock_moves (
  seq            bigint GENERATED ALWAYS AS IDENTITY,
  id             text PRIMARY KEY,
  org_id         text NOT NULL,
  property_id    text NOT NULL REFERENCES hotel_properties(id),
  item_id        text NOT NULL REFERENCES hotel_stock_items(id),
  business_date  date NOT NULL,
  kind           text NOT NULL CHECK (kind IN ('receipt', 'issue', 'waste', 'sale', 'count')),
  qty_milli      bigint NOT NULL,
  value_minor    bigint NOT NULL,
  outlet_id      text REFERENCES hotel_outlets(id),
  ref            text NOT NULL DEFAULT '',
  journal_id     text REFERENCES journal_entries(id),
  created_by     text,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX hotel_stock_moves_item ON hotel_stock_moves (item_id, seq);
CREATE INDEX hotel_stock_moves_date ON hotel_stock_moves (property_id, business_date);

CREATE TABLE hotel_recipe_lines (
  menu_item_id   text NOT NULL REFERENCES hotel_menu_items(id),
  stock_item_id  text NOT NULL REFERENCES hotel_stock_items(id),
  qty_milli      bigint NOT NULL CHECK (qty_milli > 0),
  PRIMARY KEY (menu_item_id, stock_item_id)
);

CREATE TABLE hotel_purchase_orders (
  id           text PRIMARY KEY,
  org_id       text NOT NULL,
  property_id  text NOT NULL REFERENCES hotel_properties(id),
  number       text NOT NULL,
  supplier     text NOT NULL,
  status       text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'approved', 'received', 'cancelled')),
  created_by   text NOT NULL,
  approved_by  text REFERENCES users(id),
  approved_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, number),
  CONSTRAINT hotel_po_second_person CHECK (approved_by IS NULL OR approved_by <> created_by),
  CHECK ((status IN ('approved', 'received')) <= (approved_by IS NOT NULL))
);

CREATE TABLE hotel_po_lines (
  seq             bigint GENERATED ALWAYS AS IDENTITY,
  id              text PRIMARY KEY,
  po_id           text NOT NULL REFERENCES hotel_purchase_orders(id),
  item_id         text NOT NULL REFERENCES hotel_stock_items(id),
  qty_milli       bigint NOT NULL CHECK (qty_milli > 0),
  unit_cost_minor bigint NOT NULL CHECK (unit_cost_minor > 0),
  received_milli  bigint NOT NULL DEFAULT 0 CHECK (received_milli >= 0),
  CHECK (received_milli <= qty_milli)
);
CREATE INDEX hotel_po_lines_po ON hotel_po_lines (po_id, seq);

CREATE TABLE hotel_goods_receipts (
  id             text PRIMARY KEY,
  org_id         text NOT NULL,
  po_id          text NOT NULL REFERENCES hotel_purchase_orders(id),
  business_date  date NOT NULL,
  value_minor    bigint NOT NULL CHECK (value_minor > 0),
  journal_id     text NOT NULL REFERENCES journal_entries(id),
  received_by    text,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE hotel_supplier_bills (
  id             text PRIMARY KEY,
  org_id         text NOT NULL,
  property_id    text NOT NULL REFERENCES hotel_properties(id),
  po_id          text NOT NULL REFERENCES hotel_purchase_orders(id),
  supplier_ref   text NOT NULL,
  amount_minor   bigint NOT NULL CHECK (amount_minor > 0),      -- goods, before VAT
  vat_minor      bigint NOT NULL DEFAULT 0 CHECK (vat_minor >= 0),
  expected_minor bigint NOT NULL,                               -- received value not yet billed, at PO prices
  variance_minor bigint NOT NULL,
  status         text NOT NULL CHECK (status IN ('matched', 'held', 'approved')),
  entered_by     text NOT NULL,
  approved_by    text REFERENCES users(id),
  approve_reason text,
  journal_id     text REFERENCES journal_entries(id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (po_id, supplier_ref),
  CONSTRAINT hotel_bill_second_person CHECK (approved_by IS NULL OR approved_by <> entered_by),
  CHECK ((status = 'held') = (journal_id IS NULL))
);

-- ---------------------------------------------------------------- spa and activities
CREATE TABLE hotel_services (
  id            text PRIMARY KEY,
  org_id        text NOT NULL,
  property_id   text NOT NULL REFERENCES hotel_properties(id),
  code          text NOT NULL,
  name          text NOT NULL,
  kind          text NOT NULL CHECK (kind IN ('treatment', 'activity')),
  department    text NOT NULL CHECK (department IN ('spa', 'other')),
  duration_min  integer NOT NULL CHECK (duration_min BETWEEN 5 AND 1440),
  price_minor   bigint NOT NULL CHECK (price_minor > 0),            -- per participant
  capacity      integer NOT NULL DEFAULT 1 CHECK (capacity > 0),
  active        boolean NOT NULL DEFAULT true,
  UNIQUE (property_id, code),
  CHECK (kind = 'activity' OR capacity = 1)
);

CREATE TABLE hotel_providers (
  id           text PRIMARY KEY,
  org_id       text NOT NULL,
  property_id  text NOT NULL REFERENCES hotel_properties(id),
  name         text NOT NULL,
  kind         text NOT NULL CHECK (kind IN ('therapist', 'guide', 'instructor')),
  user_id      text REFERENCES users(id),
  active       boolean NOT NULL DEFAULT true
);

CREATE TABLE hotel_resources (
  id           text PRIMARY KEY,
  org_id       text NOT NULL,
  property_id  text NOT NULL REFERENCES hotel_properties(id),
  name         text NOT NULL,
  kind         text NOT NULL CHECK (kind IN ('treatment_room', 'studio', 'equipment')),
  active       boolean NOT NULL DEFAULT true
);

CREATE TABLE hotel_service_bookings (
  id            text PRIMARY KEY,
  org_id        text NOT NULL,
  property_id   text NOT NULL REFERENCES hotel_properties(id),
  service_id    text NOT NULL REFERENCES hotel_services(id),
  provider_id   text NOT NULL REFERENCES hotel_providers(id),
  resource_id   text REFERENCES hotel_resources(id),
  guest_name    text NOT NULL,
  stay_id       text REFERENCES hotel_stays(id),
  starts_at     timestamp NOT NULL,                       -- the hotel's local time
  ends_at       timestamp NOT NULL,
  participants  integer NOT NULL DEFAULT 1 CHECK (participants > 0),
  -- bookings that share a session (the same activity at the same start) may share a guide and a room
  session_key   text NOT NULL,
  source        text NOT NULL CHECK (source IN ('front_desk', 'online', 'in_house', 'phone')),
  status        text NOT NULL DEFAULT 'booked' CHECK (status IN ('booked', 'completed', 'cancelled', 'no_show')),
  folio_id      text REFERENCES hotel_folios(id),
  cancel_reason text,
  created_by    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at),
  CONSTRAINT hotel_provider_not_double_booked EXCLUDE USING gist
    (provider_id WITH =, tsrange(starts_at, ends_at) WITH &&, session_key WITH <>) WHERE (status IN ('booked', 'completed')),
  CONSTRAINT hotel_resource_not_double_booked EXCLUDE USING gist
    (resource_id WITH =, tsrange(starts_at, ends_at) WITH &&, session_key WITH <>)
    WHERE (resource_id IS NOT NULL AND status IN ('booked', 'completed'))
);
CREATE INDEX hotel_service_bookings_day ON hotel_service_bookings (property_id, starts_at);

-- ---------------------------------------------------------------- events and meetings
CREATE TABLE hotel_venues (
  id           text PRIMARY KEY,
  org_id       text NOT NULL,
  property_id  text NOT NULL REFERENCES hotel_properties(id),
  code         text NOT NULL,
  name         text NOT NULL,
  capacity     integer NOT NULL CHECK (capacity > 0),
  active       boolean NOT NULL DEFAULT true,
  UNIQUE (property_id, code)
);

CREATE TABLE hotel_events (
  id                    text PRIMARY KEY,
  org_id                text NOT NULL,
  property_id           text NOT NULL REFERENCES hotel_properties(id),
  number                text NOT NULL,
  name                  text NOT NULL,
  corporate_account_id  text REFERENCES hotel_corporate_accounts(id),
  contact_name          text NOT NULL,
  contact_email         text,
  venue_id              text NOT NULL REFERENCES hotel_venues(id),
  date                  date NOT NULL,
  start_time            text NOT NULL,
  end_time              text NOT NULL,
  starts_at             timestamp NOT NULL,
  ends_at               timestamp NOT NULL,
  pax                   integer NOT NULL CHECK (pax > 0),
  setup                 text NOT NULL CHECK (setup IN ('theatre', 'classroom', 'boardroom', 'banquet', 'cocktail', 'u_shape')),
  status                text NOT NULL DEFAULT 'quote' CHECK (status IN ('quote', 'contract', 'billed', 'cancelled')),
  contract_ref          text,
  beo_version           integer NOT NULL DEFAULT 1 CHECK (beo_version > 0),
  notes                 text NOT NULL DEFAULT '',
  folio_id              text REFERENCES hotel_folios(id),
  cancel_reason         text,
  created_by            text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, number),
  CHECK (ends_at > starts_at),
  CHECK ((status = 'billed') = (folio_id IS NOT NULL)),
  -- a contracted venue is never double-booked
  CONSTRAINT hotel_venue_not_double_booked EXCLUDE USING gist (venue_id WITH =, tsrange(starts_at, ends_at) WITH &&)
    WHERE (status IN ('contract', 'billed'))
);
CREATE INDEX hotel_events_date ON hotel_events (property_id, date);

CREATE TABLE hotel_event_items (
  seq          bigint GENERATED ALWAYS AS IDENTITY,
  id           text PRIMARY KEY,
  event_id     text NOT NULL REFERENCES hotel_events(id),
  kind         text NOT NULL CHECK (kind IN ('venue_hire', 'fnb', 'av', 'other')),
  description  text NOT NULL,
  department   text NOT NULL CHECK (department IN ('rooms', 'fnb', 'spa', 'other')),
  quantity     integer NOT NULL CHECK (quantity > 0),
  unit_minor   bigint NOT NULL CHECK (unit_minor > 0),
  time_label   text NOT NULL DEFAULT '',
  notes        text NOT NULL DEFAULT ''
);
CREATE INDEX hotel_event_items_event ON hotel_event_items (event_id, seq);

CREATE TABLE hotel_event_deposits (
  id              text PRIMARY KEY,
  org_id          text NOT NULL,
  property_id     text NOT NULL REFERENCES hotel_properties(id),
  event_id        text NOT NULL REFERENCES hotel_events(id),
  amount_minor    bigint NOT NULL CHECK (amount_minor > 0),
  method          text NOT NULL CHECK (method IN ('card', 'mobile_money', 'bank_transfer')),
  reference       text NOT NULL,
  received_date   date NOT NULL,
  journal_id      text NOT NULL REFERENCES journal_entries(id),
  applied_line_id text REFERENCES hotel_folio_lines(id),
  created_by      text
);

-- ---------------------------------------------------------------- payroll inputs, tips and service charge (salaries: payroll role only)
CREATE TABLE hotel_staff_pay (
  id              text PRIMARY KEY,
  org_id          text NOT NULL,
  property_id     text NOT NULL REFERENCES hotel_properties(id),
  user_id         text REFERENCES users(id),
  name            text NOT NULL,
  department      text NOT NULL CHECK (department IN ('rooms', 'fnb', 'spa', 'other', 'admin')),
  basis           text NOT NULL CHECK (basis IN ('monthly', 'hourly')),
  monthly_minor   bigint NOT NULL DEFAULT 0 CHECK (monthly_minor >= 0),
  hourly_minor    bigint NOT NULL DEFAULT 0 CHECK (hourly_minor >= 0),
  service_points  integer NOT NULL DEFAULT 1 CHECK (service_points >= 0),
  active          boolean NOT NULL DEFAULT true,
  CHECK ((basis = 'monthly' AND monthly_minor > 0) OR (basis = 'hourly' AND hourly_minor > 0))
);
CREATE UNIQUE INDEX hotel_staff_pay_user ON hotel_staff_pay (property_id, user_id) WHERE user_id IS NOT NULL;
CREATE UNIQUE INDEX hotel_staff_pay_name ON hotel_staff_pay (property_id, lower(name));

CREATE TABLE hotel_pay_runs (
  id            text PRIMARY KEY,
  org_id        text NOT NULL,
  property_id   text NOT NULL REFERENCES hotel_properties(id),
  number        text NOT NULL,
  period        text NOT NULL CHECK (period ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  status        text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'approved')),
  gross_minor   bigint NOT NULL CHECK (gross_minor > 0),
  prepared_by   text NOT NULL,
  approved_by   text REFERENCES users(id),
  journal_id    text REFERENCES journal_entries(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, number),
  UNIQUE (property_id, period),
  CONSTRAINT hotel_pay_run_second_person CHECK (approved_by IS NULL OR approved_by <> prepared_by),
  CHECK ((status = 'approved') = (approved_by IS NOT NULL AND journal_id IS NOT NULL))
);

CREATE TABLE hotel_pay_run_lines (
  run_id             text NOT NULL REFERENCES hotel_pay_runs(id),
  staff_id           text NOT NULL REFERENCES hotel_staff_pay(id),
  department         text NOT NULL,
  regular_minutes    integer NOT NULL DEFAULT 0 CHECK (regular_minutes >= 0),
  overtime_minutes   integer NOT NULL DEFAULT 0 CHECK (overtime_minutes >= 0),
  base_minor         bigint NOT NULL CHECK (base_minor >= 0),
  overtime_minor     bigint NOT NULL CHECK (overtime_minor >= 0),
  allowances_minor   bigint NOT NULL CHECK (allowances_minor >= 0),
  gross_minor        bigint NOT NULL CHECK (gross_minor >= 0),
  PRIMARY KEY (run_id, staff_id),
  CHECK (gross_minor = base_minor + overtime_minor + allowances_minor)
);

CREATE TABLE hotel_distributions (
  id            text PRIMARY KEY,
  org_id        text NOT NULL,
  property_id   text NOT NULL REFERENCES hotel_properties(id),
  kind          text NOT NULL CHECK (kind IN ('tips', 'service_charge')),
  up_to         date NOT NULL,
  pool_minor    bigint NOT NULL CHECK (pool_minor > 0),
  journal_id    text NOT NULL REFERENCES journal_entries(id),
  prepared_by   text,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE hotel_distribution_lines (
  distribution_id  text NOT NULL REFERENCES hotel_distributions(id),
  staff_id         text NOT NULL REFERENCES hotel_staff_pay(id),
  points           integer NOT NULL CHECK (points > 0),
  amount_minor     bigint NOT NULL CHECK (amount_minor >= 0),
  PRIMARY KEY (distribution_id, staff_id)
);

-- ---------------------------------------------------------------- labour planning
CREATE TABLE hotel_labour_standards (
  property_id       text NOT NULL REFERENCES hotel_properties(id),
  department        text NOT NULL CHECK (department IN ('rooms', 'fnb', 'spa', 'other', 'admin')),
  basis             text NOT NULL CHECK (basis IN ('per_occupied_room', 'per_cover', 'per_event_guest', 'fixed_per_day')),
  org_id            text NOT NULL,
  minutes_per_unit  integer NOT NULL CHECK (minutes_per_unit > 0),
  PRIMARY KEY (property_id, department, basis)
);

CREATE TABLE hotel_staff_shifts (
  id           text PRIMARY KEY,
  org_id       text NOT NULL,
  property_id  text NOT NULL REFERENCES hotel_properties(id),
  staff_id     text NOT NULL REFERENCES hotel_staff_pay(id),
  department   text NOT NULL,
  date         date NOT NULL,
  start_time   text NOT NULL,
  end_time     text NOT NULL,
  starts_at    timestamp NOT NULL,
  ends_at      timestamp NOT NULL,
  minutes      integer NOT NULL CHECK (minutes > 0),
  created_by   text,
  CHECK (ends_at > starts_at),
  CONSTRAINT hotel_shift_no_overlap EXCLUDE USING gist (staff_id WITH =, tsrange(starts_at, ends_at) WITH &&)
);
CREATE INDEX hotel_staff_shifts_date ON hotel_staff_shifts (property_id, date);

-- ---------------------------------------------------------------- budgets, fixed assets, FF&E reserve
CREATE TABLE hotel_budgets (
  property_id      text NOT NULL REFERENCES hotel_properties(id),
  month            text NOT NULL CHECK (month ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  kind             text NOT NULL CHECK (kind IN ('budget', 'forecast')),
  org_id           text NOT NULL,
  rooms_sold       integer NOT NULL CHECK (rooms_sold >= 0),
  rooms_minor      bigint NOT NULL CHECK (rooms_minor >= 0),
  fnb_minor        bigint NOT NULL CHECK (fnb_minor >= 0),
  spa_minor        bigint NOT NULL CHECK (spa_minor >= 0),
  other_minor      bigint NOT NULL CHECK (other_minor >= 0),
  costs_minor      bigint NOT NULL CHECK (costs_minor >= 0),
  entered_by       text,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (property_id, month, kind)
);

CREATE TABLE hotel_fixed_assets (
  id               text PRIMARY KEY,
  org_id           text NOT NULL,
  property_id      text NOT NULL REFERENCES hotel_properties(id),
  number           text NOT NULL,
  name             text NOT NULL,
  category         text NOT NULL CHECK (category IN ('ffe', 'equipment', 'it', 'vehicle', 'building')),
  acquired_on      date NOT NULL,
  cost_minor       bigint NOT NULL CHECK (cost_minor > 0),
  residual_minor   bigint NOT NULL DEFAULT 0 CHECK (residual_minor >= 0),
  life_months      integer NOT NULL CHECK (life_months > 0),
  funded_from      text NOT NULL CHECK (funded_from IN ('bank', 'payable', 'ffe_reserve')),
  status           text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disposed')),
  disposed_on      date,
  proceeds_minor   bigint CHECK (proceeds_minor >= 0),
  journal_id       text NOT NULL REFERENCES journal_entries(id),
  disposal_journal_id text REFERENCES journal_entries(id),
  created_by       text,
  UNIQUE (org_id, number),
  CHECK (residual_minor < cost_minor),
  CHECK ((status = 'disposed') = (disposed_on IS NOT NULL))
);

CREATE TABLE hotel_depreciation (
  asset_id      text NOT NULL REFERENCES hotel_fixed_assets(id),
  month         text NOT NULL,
  org_id        text NOT NULL,
  amount_minor  bigint NOT NULL CHECK (amount_minor > 0),
  journal_id    text NOT NULL REFERENCES journal_entries(id),
  PRIMARY KEY (asset_id, month)
);

CREATE TABLE hotel_ffe_contributions (
  property_id    text NOT NULL REFERENCES hotel_properties(id),
  month          text NOT NULL,
  org_id         text NOT NULL,
  revenue_minor  bigint NOT NULL,
  rate_bp        integer NOT NULL,
  amount_minor   bigint NOT NULL CHECK (amount_minor > 0),
  journal_id     text NOT NULL REFERENCES journal_entries(id),
  created_by     text,
  PRIMARY KEY (property_id, month)
);

-- ---------------------------------------------------------------- revenue management and corporate sales
CREATE TABLE hotel_rate_suggestions (
  id               text PRIMARY KEY,
  org_id           text NOT NULL,
  property_id      text NOT NULL REFERENCES hotel_properties(id),
  date             date NOT NULL,
  room_type_id     text NOT NULL REFERENCES hotel_room_types(id),
  rate_plan_id     text NOT NULL REFERENCES hotel_rate_plans(id),
  current_minor    bigint NOT NULL,
  suggested_minor  bigint NOT NULL CHECK (suggested_minor > 0),
  change_bp        integer NOT NULL,
  reason           text NOT NULL,
  applied_by       text NOT NULL,
  applied_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (property_id, date, room_type_id)
);

CREATE TABLE hotel_rfps (
  id                    text PRIMARY KEY,
  org_id                text NOT NULL,
  property_id           text NOT NULL REFERENCES hotel_properties(id),
  number                text NOT NULL,
  corporate_account_id  text NOT NULL REFERENCES hotel_corporate_accounts(id),
  season_from           date NOT NULL,
  season_to             date NOT NULL,
  rates                 jsonb NOT NULL,                     -- [{ roomTypeId, amountMinor }]
  expected_room_nights  integer NOT NULL CHECK (expected_room_nights >= 0),
  status                text NOT NULL DEFAULT 'submitted' CHECK (status IN ('submitted', 'accepted', 'declined')),
  rate_plan_id          text REFERENCES hotel_rate_plans(id),
  decided_by            text,
  decision_reason       text,
  created_by            text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, number),
  CHECK (season_to >= season_from),
  CHECK ((status = 'accepted') = (rate_plan_id IS NOT NULL))
);

-- ---------------------------------------------------------------- operations: housekeeping log, preventive plans, meters
CREATE TABLE hotel_hk_cleans (
  id            text PRIMARY KEY,
  org_id        text NOT NULL,
  property_id   text NOT NULL REFERENCES hotel_properties(id),
  room_id       text NOT NULL REFERENCES hotel_rooms(id),
  attendant     text,
  business_date date NOT NULL,
  minutes       integer NOT NULL CHECK (minutes >= 0),
  checklist     jsonb NOT NULL DEFAULT '{}',
  ticket_id     text REFERENCES hotel_maintenance(id),
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX hotel_hk_cleans_date ON hotel_hk_cleans (property_id, business_date);

CREATE TABLE hotel_maintenance_plans (
  id           text PRIMARY KEY,
  org_id       text NOT NULL,
  property_id  text NOT NULL REFERENCES hotel_properties(id),
  title        text NOT NULL,
  asset_label  text NOT NULL,
  room_id      text REFERENCES hotel_rooms(id),
  every_days   integer NOT NULL CHECK (every_days BETWEEN 1 AND 3650),
  next_due     date NOT NULL,
  active       boolean NOT NULL DEFAULT true,
  created_by   text
);
ALTER TABLE hotel_maintenance ADD COLUMN plan_id text REFERENCES hotel_maintenance_plans(id);
-- a preventive plan raises one ticket per due date
CREATE UNIQUE INDEX hotel_maintenance_plan_once ON hotel_maintenance (plan_id, due_date) WHERE plan_id IS NOT NULL;

CREATE TABLE hotel_meter_readings (
  property_id  text NOT NULL REFERENCES hotel_properties(id),
  date         date NOT NULL,
  kind         text NOT NULL CHECK (kind IN ('energy_kwh', 'water_m3', 'waste_kg')),
  org_id       text NOT NULL,
  qty_milli    bigint NOT NULL CHECK (qty_milli >= 0),
  recorded_by  text,
  PRIMARY KEY (property_id, date, kind)
);
