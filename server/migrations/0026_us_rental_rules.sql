-- Local rental rules for the United States (contracts/src/rental-rules.ts), starting with New York City:
-- the host's OSE short-term rental registration (Local Law 18) and the FARE Act tenant-fee disclosure.
-- Additive only: existing listings keep every value and gain empty defaults.
ALTER TABLE agency_listings
  ADD COLUMN str_registration_number text NOT NULL DEFAULT '',
  ADD COLUMN host_present boolean NOT NULL DEFAULT false,
  ADD COLUMN tenant_fees jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(tenant_fees) = 'array'),
  ADD COLUMN no_tenant_broker_fee boolean NOT NULL DEFAULT false,
  ADD COLUMN str_verified_by text NULL REFERENCES users(id),
  ADD COLUMN str_verified_at timestamptz NULL;
