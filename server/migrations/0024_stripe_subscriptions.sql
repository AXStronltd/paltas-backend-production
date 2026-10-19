-- Stripe is optional. One hosted recurring subscription per organisation/product.
-- No existing business, trial or payment records are rewritten.
CREATE TABLE stripe_checkouts (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES organisations(id),
  product text NOT NULL,
  plan_id text NOT NULL REFERENCES catalogue_plans(id),
  invoice_id text NOT NULL UNIQUE REFERENCES billing_invoices(id),
  price_id text NOT NULL,
  amount_minor bigint NOT NULL CHECK(amount_minor > 0),
  currency text NOT NULL,
  frequency text NOT NULL CHECK(frequency IN ('monthly','quarterly','yearly')),
  session_id text UNIQUE,
  checkout_url text,
  stripe_subscription_id text UNIQUE,
  stripe_customer_id text,
  status text NOT NULL DEFAULT 'pending',
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(org_id,product) REFERENCES subscriptions(org_id,product)
);
CREATE UNIQUE INDEX stripe_one_open_product ON stripe_checkouts(org_id,product)
  WHERE status NOT IN ('canceled','incomplete_expired','expired');
CREATE TABLE stripe_invoice_links (
  stripe_invoice_id text PRIMARY KEY,
  checkout_id text NOT NULL REFERENCES stripe_checkouts(id),
  invoice_id text NOT NULL UNIQUE REFERENCES billing_invoices(id)
);
CREATE TABLE stripe_events (
  id text PRIMARY KEY,
  type text NOT NULL,
  result text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
