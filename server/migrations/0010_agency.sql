-- Agent / Host (product "agency") and the public PALTAS marketplace.
-- Every org table carries org_id; money is bigint minor units in the organisation's currency; percentages are basis
-- points (1 % = 100). Money posts to the ONE ledger (journal_entries) through the ledger service.
-- Invariants the database itself enforces:
--   * a listing is public only after PALTAS staff approved it (published needs a reviewer);
--   * a stay listing never holds two overlapping confirmed stays or blocks (exclusion constraint);
--   * an agent never has two live viewings within the same hour (exclusion constraint);
--   * one deal per listing, one commission per deal; a commission is approved by someone other than who raised it;
--   * a host payout is approved by someone other than who prepared it; a payment reference is recorded once;
--   * one review per completed stay.
-- Needs 0007 (the shared contacts table).

CREATE EXTENSION IF NOT EXISTS btree_gist;

-- ---------------------------------------------------------------- catalogue: agency plans (DEMO prices, like the core seed)
-- KES prices are PALTAS demo configuration, to be confirmed before any customer is billed. Super Admin changes them
-- through the admin API; nothing in the code reads a price. Never overwrites an existing plan.
INSERT INTO catalogue_plans (id, name, tier, product, modules, buildings_included, base_minor, extra_building_minor,
  currency, trial_days, tax_pct, tax_note, cap_sites, cap_units)
VALUES
  ('AGENCY-STD', 'Real Estate Agency — Standard', 'Standard', 'agency', ARRAY['crm', 'docs'], 0, 1500000, NULL,
   'KES', 30, 16, 'Demo configuration — VAT as configured by PALTAS; confirm with your tax adviser', NULL, NULL),
  ('AGENCY-PRO', 'Real Estate Agency — Pro (agents and hosts)', 'Pro', 'agency',
   ARRAY['crm', 'finance', 'payments', 'docs', 'automation'], 0, 4500000, NULL,
   'KES', 30, 16, 'Demo configuration — VAT as configured by PALTAS; confirm with your tax adviser', NULL, NULL)
ON CONFLICT (id) DO NOTHING;

-- Can this organisation's product subscription show records to the public today? Mirrors the entitlement rules:
-- active, or a trial that has not ended, and no cancellation that has taken effect.
CREATE FUNCTION mkt_org_usable(p_org text, p_product text, p_today date) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM subscriptions s
    WHERE s.org_id = p_org AND s.product = p_product
      AND (s.status = 'active' OR (s.status = 'trial' AND (s.trial_ends IS NULL OR s.trial_ends >= p_today)))
      AND NOT EXISTS (SELECT 1 FROM subscription_pending p
                      WHERE p.org_id = s.org_id AND p.product = s.product AND p.type = 'cancel' AND p.effective <= p_today))
$$;

-- ---------------------------------------------------------------- people
-- Enquirers, buyers, guests, sellers, landlords and stay owners are the organisation's ONE contact store (contacts,
-- migration 0007): every agency table points at contacts(id), so a contact merge moves agency records too.

-- ---------------------------------------------------------------- commission agreements (per client)
CREATE TABLE agency_agreements (
  id                     text PRIMARY KEY,
  org_id                 text NOT NULL REFERENCES organisations(id),
  number                 text NOT NULL,
  kind                   text NOT NULL CHECK (kind IN ('sale', 'letting', 'stay_management')),
  client_contact_id      text NOT NULL REFERENCES contacts(id),
  commission_bp          integer NOT NULL CHECK (commission_bp BETWEEN 0 AND 10000),
  commission_fixed_minor bigint NOT NULL DEFAULT 0 CHECK (commission_fixed_minor >= 0),
  vat_bp                 integer NOT NULL CHECK (vat_bp BETWEEN 0 AND 10000),
  agent_share_bp         integer NOT NULL DEFAULT 0 CHECK (agent_share_bp BETWEEN 0 AND 10000),
  starts_on              date NOT NULL,
  ends_on                date,
  status                 text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'ended')),
  created_by             text NOT NULL REFERENCES users(id),
  created_at             timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, number),
  CHECK (ends_on IS NULL OR ends_on >= starts_on),
  CHECK (commission_bp > 0 OR commission_fixed_minor > 0 OR kind = 'stay_management')
);

-- ---------------------------------------------------------------- listings
CREATE TABLE agency_listings (
  id                  text PRIMARY KEY,
  org_id              text NOT NULL REFERENCES organisations(id),
  product             text NOT NULL CHECK (product IN ('agency', 'property')),
  number              text NOT NULL,
  purpose             text NOT NULL CHECK (purpose IN ('sale', 'rent', 'stay')),
  property_type       text NOT NULL,
  title               text NOT NULL,
  description         text NOT NULL DEFAULT '',
  country             text NOT NULL,
  city                text NOT NULL,
  area                text NOT NULL DEFAULT '',
  address_private     text NOT NULL DEFAULT '',           -- never public
  bedrooms            integer NOT NULL DEFAULT 0 CHECK (bedrooms >= 0),
  bathrooms           integer NOT NULL DEFAULT 0 CHECK (bathrooms >= 0),
  size_m2             integer CHECK (size_m2 > 0),
  max_guests          integer CHECK (max_guests > 0),
  amenities           text[] NOT NULL DEFAULT '{}',
  currency            char(3) NOT NULL,
  price_minor         bigint NOT NULL CHECK (price_minor > 0),  -- sale price, monthly rent or nightly rate
  deposit_minor       bigint NOT NULL DEFAULT 0 CHECK (deposit_minor >= 0),
  cleaning_fee_minor  bigint NOT NULL DEFAULT 0 CHECK (cleaning_fee_minor >= 0),
  service_fee_bp      integer NOT NULL DEFAULT 0 CHECK (service_fee_bp BETWEEN 0 AND 5000),
  tax_bp              integer NOT NULL DEFAULT 0 CHECK (tax_bp BETWEEN 0 AND 5000),
  min_nights          integer NOT NULL DEFAULT 1 CHECK (min_nights BETWEEN 1 AND 365),
  instant_book        boolean NOT NULL DEFAULT false,
  owner_contact_id    text REFERENCES contacts(id),  -- seller / landlord / stay owner (private)
  agreement_id        text REFERENCES agency_agreements(id),
  agent_user          text REFERENCES users(id),
  status              text NOT NULL DEFAULT 'draft'
                      CHECK (status IN ('draft', 'pending_review', 'published', 'paused', 'rejected', 'closed')),
  submitted_by        text REFERENCES users(id),
  submitted_at        timestamptz,
  reviewed_by         text REFERENCES users(id),       -- PALTAS staff
  reviewed_at         timestamptz,
  review_note         text NOT NULL DEFAULT '',
  published_at        timestamptz,
  created_by          text NOT NULL REFERENCES users(id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, number),
  -- only PALTAS staff publish: a public listing always names who approved it
  CONSTRAINT agency_listing_published_reviewed CHECK (status <> 'published' OR (reviewed_by IS NOT NULL AND published_at IS NOT NULL)),
  CONSTRAINT agency_listing_stay_guests CHECK (purpose <> 'stay' OR max_guests IS NOT NULL)
);
CREATE INDEX agency_listings_public ON agency_listings (status, purpose, lower(city), price_minor);
CREATE INDEX agency_listings_org ON agency_listings (org_id, status);

-- media metadata only: the bytes live with a storage provider adapter (none connected yet)
CREATE TABLE agency_listing_media (
  id            text PRIMARY KEY,
  listing_id    text NOT NULL REFERENCES agency_listings(id),
  org_id        text NOT NULL,
  kind          text NOT NULL CHECK (kind IN ('photo', 'video', 'floor_plan', 'tour', 'document')),
  file_name     text NOT NULL,
  content_type  text NOT NULL,
  size_bytes    bigint NOT NULL CHECK (size_bytes > 0),
  sha256        char(64) NOT NULL,
  caption       text NOT NULL DEFAULT '',
  position      integer NOT NULL DEFAULT 0,
  storage       text NOT NULL,               -- adapter name
  storage_key   text NOT NULL,
  created_by    text NOT NULL REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (listing_id, sha256)
);

-- public detail views per listing and day (counted by the marketplace; no visitor data is kept)
CREATE TABLE agency_listing_views (
  listing_id  text NOT NULL REFERENCES agency_listings(id),
  org_id      text NOT NULL,
  date        date NOT NULL,
  views       integer NOT NULL CHECK (views > 0),
  PRIMARY KEY (listing_id, date)
);

-- ---------------------------------------------------------------- inbox: public enquiries and viewing requests
CREATE TABLE agency_enquiries (
  id               text PRIMARY KEY,
  org_id           text NOT NULL REFERENCES organisations(id),
  number           text NOT NULL,
  kind             text NOT NULL CHECK (kind IN ('enquiry', 'viewing_request')),
  listing_id       text NOT NULL REFERENCES agency_listings(id),
  contact_id       text NOT NULL REFERENCES contacts(id),
  message          text NOT NULL DEFAULT '',
  preferred_date   date,
  preferred_time   text,
  source           text NOT NULL DEFAULT 'PALTAS marketplace',
  status           text NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'converted', 'closed', 'spam')),
  lead_id          text,
  handled_by       text REFERENCES users(id),
  handled_at       timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, number)
);
CREATE INDEX agency_enquiries_org ON agency_enquiries (org_id, status, created_at DESC);

-- ---------------------------------------------------------------- leads, viewings
CREATE TABLE agency_leads (
  id                 text PRIMARY KEY,
  org_id             text NOT NULL REFERENCES organisations(id),
  number             text NOT NULL,
  contact_id         text NOT NULL REFERENCES contacts(id),
  listing_id         text REFERENCES agency_listings(id),
  source             text NOT NULL,
  stage              text NOT NULL DEFAULT 'new'
                     CHECK (stage IN ('new', 'contacted', 'qualified', 'viewing', 'viewed', 'offer', 'won', 'lost')),
  agent_user         text REFERENCES users(id),
  budget_minor       bigint CHECK (budget_minor > 0),
  lost_reason        text,
  stage_at           timestamptz NOT NULL DEFAULT now(),
  first_response_at  timestamptz,
  created_by         text REFERENCES users(id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, number),
  CHECK (stage <> 'lost' OR lost_reason IS NOT NULL)
);
CREATE INDEX agency_leads_org ON agency_leads (org_id, stage);
ALTER TABLE agency_enquiries ADD CONSTRAINT agency_enquiries_lead FOREIGN KEY (lead_id) REFERENCES agency_leads(id);

-- the lead's history: stage changes, notes, calls, viewings (append-only)
CREATE TABLE agency_lead_events (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  lead_id     text NOT NULL REFERENCES agency_leads(id),
  org_id      text NOT NULL,
  kind        text NOT NULL,
  text        text NOT NULL,
  by_user     text REFERENCES users(id),
  at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX agency_lead_events_lead ON agency_lead_events (lead_id, id);

CREATE TABLE agency_viewings (
  id          text PRIMARY KEY,
  org_id      text NOT NULL REFERENCES organisations(id),
  number      text NOT NULL,
  lead_id     text NOT NULL REFERENCES agency_leads(id),
  listing_id  text NOT NULL REFERENCES agency_listings(id),
  contact_id  text NOT NULL REFERENCES contacts(id),
  agent_user  text NOT NULL REFERENCES users(id),
  date        date NOT NULL,
  time        text NOT NULL CHECK (time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  starts_at   timestamp NOT NULL,             -- date + time, local to the organisation
  status     text NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'confirmed', 'completed', 'no_show', 'cancelled')),
  feedback    text NOT NULL DEFAULT '',
  interest    integer CHECK (interest BETWEEN 1 AND 5),
  created_by  text NOT NULL REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, number),
  CHECK (starts_at::date = date AND to_char(starts_at, 'HH24:MI') = time),
  -- an agent cannot be in two viewings that start less than an hour apart
  CONSTRAINT agency_agent_viewing_clash EXCLUDE USING gist (
    agent_user WITH =,
    tsrange(starts_at - interval '30 minutes', starts_at + interval '30 minutes') WITH &&)
    WHERE (status IN ('scheduled', 'confirmed'))
);

-- ---------------------------------------------------------------- offers on sale (and rent) listings
CREATE TABLE agency_offers (
  id             text PRIMARY KEY,
  org_id         text NOT NULL REFERENCES organisations(id),
  number         text NOT NULL,
  listing_id     text NOT NULL REFERENCES agency_listings(id),
  contact_id     text NOT NULL REFERENCES contacts(id),
  lead_id        text REFERENCES agency_leads(id),
  amount_minor   bigint NOT NULL CHECK (amount_minor > 0),
  counter_minor  bigint CHECK (counter_minor > 0),
  message        text NOT NULL DEFAULT '',
  status         text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'countered', 'accepted', 'rejected', 'withdrawn')),
  token_hash     char(64) NOT NULL,           -- the buyer's private link (SHA-256; the token is shown once)
  decided_by     text REFERENCES users(id),
  decided_at     timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, number),
  CHECK (status <> 'countered' OR counter_minor IS NOT NULL)
);
-- at most one accepted offer per listing
CREATE UNIQUE INDEX agency_offers_one_accepted ON agency_offers (listing_id) WHERE status = 'accepted';

-- ---------------------------------------------------------------- deals and commissions
CREATE TABLE agency_deals (
  id            text PRIMARY KEY,
  org_id        text NOT NULL REFERENCES organisations(id),
  number        text NOT NULL,
  listing_id    text NOT NULL REFERENCES agency_listings(id),
  lead_id       text REFERENCES agency_leads(id),
  offer_id      text REFERENCES agency_offers(id),
  agreement_id  text NOT NULL REFERENCES agency_agreements(id),
  kind          text NOT NULL CHECK (kind IN ('sale', 'letting')),
  value_minor   bigint NOT NULL CHECK (value_minor > 0),
  closed_on     date NOT NULL,
  agent_user    text REFERENCES users(id),
  closed_by     text NOT NULL REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, number),
  UNIQUE (listing_id)
);

CREATE TABLE agency_commissions (
  id                  text PRIMARY KEY,
  org_id              text NOT NULL REFERENCES organisations(id),
  number              text NOT NULL,
  deal_id             text NOT NULL UNIQUE REFERENCES agency_deals(id),
  agreement_id        text NOT NULL REFERENCES agency_agreements(id),
  client_contact_id   text NOT NULL REFERENCES contacts(id),
  base_minor          bigint NOT NULL CHECK (base_minor > 0),
  commission_minor    bigint NOT NULL CHECK (commission_minor > 0),
  vat_minor           bigint NOT NULL CHECK (vat_minor >= 0),
  total_minor         bigint NOT NULL,
  agent_user          text REFERENCES users(id),
  agent_share_minor   bigint NOT NULL DEFAULT 0 CHECK (agent_share_minor >= 0),
  received_minor      bigint NOT NULL DEFAULT 0 CHECK (received_minor >= 0),
  status              text NOT NULL DEFAULT 'pending_approval' CHECK (status IN ('pending_approval', 'approved', 'rejected', 'paid')),
  raised_by           text NOT NULL REFERENCES users(id),
  approved_by         text REFERENCES users(id),
  approved_at         timestamptz,
  reject_reason       text,
  journal_id          text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, number),
  CHECK (total_minor = commission_minor + vat_minor),
  CHECK (agent_share_minor <= commission_minor),
  CHECK (received_minor <= total_minor),
  CONSTRAINT agency_commission_second_person CHECK (approved_by IS NULL OR approved_by <> raised_by)
);

CREATE TABLE agency_commission_receipts (
  id             text PRIMARY KEY,
  org_id         text NOT NULL,
  commission_id  text NOT NULL REFERENCES agency_commissions(id),
  amount_minor   bigint NOT NULL CHECK (amount_minor > 0),
  reference      text NOT NULL,
  received_on    date NOT NULL,
  recorded_by    text NOT NULL REFERENCES users(id),
  journal_id     text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, reference)
);

-- ---------------------------------------------------------------- short stays: one calendar per stay listing
-- Bookings and owner/maintenance blocks share one table so the exclusion constraint covers both.
CREATE TABLE agency_stays (
  id                  text PRIMARY KEY,
  org_id              text NOT NULL REFERENCES organisations(id),
  number              text NOT NULL,
  listing_id          text NOT NULL REFERENCES agency_listings(id),
  kind                text NOT NULL CHECK (kind IN ('booking', 'block')),
  contact_id          text REFERENCES contacts(id),   -- the guest (bookings)
  check_in            date NOT NULL,
  check_out           date NOT NULL,
  guests              integer NOT NULL DEFAULT 1 CHECK (guests > 0),
  source              text NOT NULL CHECK (source IN ('marketplace', 'direct', 'owner', 'maintenance')),
  status              text NOT NULL CHECK (status IN ('requested', 'confirmed', 'checked_in', 'completed', 'cancelled', 'declined')),
  accommodation_minor bigint NOT NULL DEFAULT 0 CHECK (accommodation_minor >= 0),
  cleaning_minor      bigint NOT NULL DEFAULT 0 CHECK (cleaning_minor >= 0),
  service_fee_minor   bigint NOT NULL DEFAULT 0 CHECK (service_fee_minor >= 0),
  tax_minor           bigint NOT NULL DEFAULT 0 CHECK (tax_minor >= 0),
  total_minor         bigint NOT NULL DEFAULT 0,
  paid_minor          bigint NOT NULL DEFAULT 0 CHECK (paid_minor >= 0),
  owner_contact_id    text REFERENCES contacts(id),   -- fixed at booking: who the stay earns for
  management_bp       integer NOT NULL DEFAULT 0 CHECK (management_bp BETWEEN 0 AND 10000),
  note                text NOT NULL DEFAULT '',
  token_hash          char(64),                              -- the guest's private link (bookings from the marketplace)
  decided_by          text REFERENCES users(id),
  completed_journal   text,
  created_by          text REFERENCES users(id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, number),
  CHECK (check_out > check_in),
  CHECK (total_minor = accommodation_minor + cleaning_minor + service_fee_minor + tax_minor),
  CHECK (kind = 'block' OR contact_id IS NOT NULL),
  -- a stay listing never holds two overlapping confirmed stays or blocks
  CONSTRAINT agency_stay_not_double_booked EXCLUDE USING gist (
    listing_id WITH =, daterange(check_in, check_out, '[)') WITH &&)
    WHERE (status IN ('confirmed', 'checked_in', 'completed'))
);
CREATE INDEX agency_stays_listing ON agency_stays (listing_id, check_in);
CREATE INDEX agency_stays_org ON agency_stays (org_id, status);

-- the price of a night when it differs from the listing's nightly rate
CREATE TABLE agency_stay_rates (
  listing_id   text NOT NULL REFERENCES agency_listings(id),
  org_id       text NOT NULL,
  date         date NOT NULL,
  price_minor  bigint NOT NULL CHECK (price_minor > 0),
  PRIMARY KEY (listing_id, date)
);

-- guest payments and refunds, RECORDED (never processed)
CREATE TABLE agency_stay_payments (
  id            text PRIMARY KEY,
  org_id        text NOT NULL,
  stay_id       text NOT NULL REFERENCES agency_stays(id),
  kind          text NOT NULL CHECK (kind IN ('payment', 'refund')),
  amount_minor  bigint NOT NULL CHECK (amount_minor > 0),
  method        text NOT NULL CHECK (method IN ('cash', 'card', 'mobile_money', 'bank_transfer')),
  reference     text NOT NULL,
  recorded_by   text NOT NULL REFERENCES users(id),
  journal_id    text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, reference)
);

-- host (stay owner) payouts: prepared by one person, approved by another; RECORDED (never processed)
CREATE TABLE agency_payouts (
  id                text PRIMARY KEY,
  org_id            text NOT NULL REFERENCES organisations(id),
  number            text NOT NULL,
  owner_contact_id  text NOT NULL REFERENCES contacts(id),
  amount_minor      bigint NOT NULL CHECK (amount_minor > 0),
  note              text NOT NULL DEFAULT '',
  status            text NOT NULL DEFAULT 'prepared' CHECK (status IN ('prepared', 'approved', 'rejected')),
  prepared_by       text NOT NULL REFERENCES users(id),
  approved_by       text REFERENCES users(id),
  approved_at       timestamptz,
  reference         text,
  journal_id        text,
  reject_reason     text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, number),
  CONSTRAINT agency_payout_second_person CHECK (approved_by IS NULL OR approved_by <> prepared_by),
  CHECK (status <> 'approved' OR (reference IS NOT NULL AND journal_id IS NOT NULL))
);
CREATE UNIQUE INDEX agency_payouts_reference ON agency_payouts (org_id, reference) WHERE reference IS NOT NULL;

-- ---------------------------------------------------------------- reviews (one per completed stay, moderated by PALTAS staff)
CREATE TABLE agency_reviews (
  id             text PRIMARY KEY,
  org_id         text NOT NULL REFERENCES organisations(id),
  listing_id     text NOT NULL REFERENCES agency_listings(id),
  stay_id        text NOT NULL UNIQUE REFERENCES agency_stays(id),
  rating         integer NOT NULL CHECK (rating BETWEEN 1 AND 5),
  text           text NOT NULL,
  display_name   text NOT NULL,
  status         text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  moderated_by   text REFERENCES users(id),
  moderated_at   timestamptz,
  moderation_note text NOT NULL DEFAULT '',
  created_at     timestamptz NOT NULL DEFAULT now(),
  CHECK (status = 'pending' OR moderated_by IS NOT NULL)
);
CREATE INDEX agency_reviews_listing ON agency_reviews (listing_id, status);

-- ---------------------------------------------------------------- "For Business" sign-up requests
-- A company asks to join PALTAS; PALTAS staff approve it into the existing organisation onboarding
-- (organisation + subscription + administrator are created by the core, never here).
CREATE TABLE mkt_business_requests (
  id                   text PRIMARY KEY,
  number               text NOT NULL UNIQUE,
  product              text NOT NULL CHECK (product IN ('property', 'developer', 'agency', 'hotel', 'security')),
  org_name             text NOT NULL,
  registration_number  text NOT NULL DEFAULT '',
  country              text NOT NULL,
  currency             char(3) NOT NULL,
  timezone             text NOT NULL,
  contact_name         text NOT NULL,
  contact_email        text NOT NULL,
  contact_phone        text NOT NULL DEFAULT '',
  modules              text[] NOT NULL DEFAULT '{}',
  details              jsonb NOT NULL DEFAULT '{}',
  status               text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  decided_by           text REFERENCES users(id),
  decided_at           timestamptz,
  decision_note        text NOT NULL DEFAULT '',
  org_id               text REFERENCES organisations(id),
  created_at           timestamptz NOT NULL DEFAULT now(),
  CHECK (status <> 'approved' OR org_id IS NOT NULL)
);
-- the same company cannot be waiting twice
CREATE UNIQUE INDEX mkt_business_requests_pending_name ON mkt_business_requests (lower(org_name), lower(country)) WHERE status = 'pending';
CREATE UNIQUE INDEX mkt_business_requests_pending_reg ON mkt_business_requests (upper(registration_number), lower(country))
  WHERE status = 'pending' AND registration_number <> '';
