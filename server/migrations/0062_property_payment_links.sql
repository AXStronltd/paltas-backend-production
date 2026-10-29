-- Confirmation permits disclosure of business-supplied manual instructions, never automatic payout or bank-ownership verification.
CREATE TABLE pm_receiving_instruction_confirmations (
 receiving_version_id text PRIMARY KEY REFERENCES pm_receiving_account_versions(id),
 org_id text NOT NULL REFERENCES organisations(id),
 confirmed_by text NOT NULL REFERENCES users(id),
 confirmed_at timestamptz NOT NULL DEFAULT now(),
 reason text NOT NULL
);
CREATE TABLE pm_invoice_payment_links (
 id text PRIMARY KEY,
 org_id text NOT NULL REFERENCES organisations(id),
 invoice_id text NOT NULL REFERENCES pm_invoices(id),
 property_id text NOT NULL REFERENCES pm_properties(id),
 token_hash text NOT NULL UNIQUE,
 receiving_version_id text REFERENCES pm_receiving_account_versions(id),
 created_by text NOT NULL REFERENCES users(id),
 created_at timestamptz NOT NULL DEFAULT now(),
 expires_at timestamptz NOT NULL,
 revoked_at timestamptz,
 request_id text REFERENCES pm_kulmipay_requests(id),
 attempt_date date,
 attempts integer NOT NULL DEFAULT 0 CHECK(attempts>=0)
);
CREATE INDEX pm_invoice_payment_links_org ON pm_invoice_payment_links(org_id,invoice_id);
