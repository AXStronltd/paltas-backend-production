-- Minimal durable lifecycle receipts. No payment data or bank details are stored here.
ALTER TABLE rent_stripe_merchants ADD COLUMN deauthorized_at timestamptz;
CREATE TABLE rent_stripe_merchant_events (
  platform_account_id text NOT NULL,
  mode text NOT NULL CHECK (mode IN ('test','live')),
  event_id text NOT NULL,
  account_id text NOT NULL,
  event_type text NOT NULL CHECK (event_type IN ('account.updated','account.application.deauthorized')),
  org_id text NOT NULL REFERENCES organisations(id),
  processed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(platform_account_id,mode,event_id)
);
CREATE INDEX rent_stripe_merchant_events_org ON rent_stripe_merchant_events(org_id,processed_at);
