-- Client-owned KulmiPay connections. Secrets are encrypted by the existing SecretBox.
CREATE TABLE pm_kulmipay_connections (
 org_id text PRIMARY KEY REFERENCES organisations(id),
 environment text NOT NULL CHECK(environment IN ('sandbox','live')),
 wallet_id text NOT NULL,
 secret_sealed text NOT NULL,
 challenge_sealed text NOT NULL,
 credential_hash text NOT NULL UNIQUE,
 connected_by text NOT NULL REFERENCES users(id),
 connected_at timestamptz NOT NULL DEFAULT now(),
 active boolean NOT NULL DEFAULT true,
 UNIQUE(environment,wallet_id)
);
CREATE TABLE pm_kulmipay_requests (
 id text PRIMARY KEY,
 org_id text NOT NULL REFERENCES pm_kulmipay_connections(org_id),
 invoice_id text NOT NULL REFERENCES pm_invoices(id),
 property_id text NOT NULL REFERENCES pm_properties(id),
 provider text NOT NULL CHECK(provider IN ('M-PESA','PESALINK')),
 environment text NOT NULL CHECK(environment IN ('sandbox','live')),
 wallet_id text NOT NULL,
 amount_minor bigint NOT NULL CHECK(amount_minor>0),
 provider_invoice_id text,
 state text NOT NULL CHECK(state IN ('initiating','uncertain','PENDING','PROCESSING','FAILED','CANCELED','PARTIAL','COMPLETE','RETRY')),
 fee_minor bigint CHECK(fee_minor>=0),
 net_minor bigint CHECK(net_minor>=0),
 clearing_status text,
 receipt_reference text,
 requested_by text NOT NULL REFERENCES users(id),
 created_at timestamptz NOT NULL DEFAULT now(),
 checked_at timestamptz,
 UNIQUE(org_id,provider_invoice_id)
);
CREATE UNIQUE INDEX pm_kulmipay_one_open_request ON pm_kulmipay_requests(org_id,invoice_id)
 WHERE state NOT IN ('FAILED','CANCELED');
CREATE INDEX pm_kulmipay_property_requests ON pm_kulmipay_requests(org_id,property_id,created_at);
