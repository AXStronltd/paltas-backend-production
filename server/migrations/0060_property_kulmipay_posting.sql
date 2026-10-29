-- Provider confirmations post to clearing, never directly to bank cash.
ALTER TABLE pm_kulmipay_requests
 ADD COLUMN provider_confirmed_at timestamptz,
 ADD COLUMN ledger_payment_id text UNIQUE REFERENCES pm_payments(id),
 ADD COLUMN posting_error text,
 ADD COLUMN posted_at timestamptz;
CREATE TABLE pm_kulmipay_settlements (
 id text PRIMARY KEY,
 org_id text NOT NULL REFERENCES organisations(id),
 bank_line_id text NOT NULL REFERENCES pm_bank_lines(id),
 amount_minor bigint NOT NULL CHECK(amount_minor>0),
 reason text NOT NULL,
 snapshot_hash text NOT NULL,
 status text NOT NULL CHECK(status IN ('prepared','approved','rejected')),
 prepared_by text NOT NULL REFERENCES users(id),
 prepared_at timestamptz NOT NULL DEFAULT now(),
 approved_by text REFERENCES users(id),
 approved_at timestamptz,
 rejected_by text REFERENCES users(id),
 rejected_reason text,
 journal_id text REFERENCES journal_entries(id),
 CHECK(approved_by IS NULL OR approved_by<>prepared_by)
);
CREATE UNIQUE INDEX pm_kulmipay_bank_settlement_once ON pm_kulmipay_settlements(bank_line_id) WHERE status IN ('prepared','approved');
ALTER TABLE pm_kulmipay_requests ADD COLUMN settlement_id text REFERENCES pm_kulmipay_settlements(id);
ALTER TABLE pm_ledger_links DROP CONSTRAINT pm_ledger_links_kind_check;
ALTER TABLE pm_ledger_links ADD CONSTRAINT pm_ledger_links_kind_check CHECK(kind IN ('invoice','receipt','collection','credit_note','deposit_refund','bill','bill_payment','payout','payroll','payroll_payment','payroll_remittance','payroll_reversal','provider_settlement'));
ALTER TABLE pm_bank_lines DROP CONSTRAINT pm_bank_lines_matched_kind_check;
ALTER TABLE pm_bank_lines ADD CONSTRAINT pm_bank_lines_matched_kind_check CHECK(matched_kind IN ('payment','payout','bill_payment','deposit_refund','provider_settlement'));
ALTER TABLE pm_kulmipay_settlements ADD COLUMN snapshot_data jsonb NOT NULL;
CREATE UNIQUE INDEX pm_kulmipay_receipt_once ON pm_kulmipay_requests(org_id,environment,upper(btrim(receipt_reference))) WHERE state='COMPLETE' AND provider='M-PESA' AND receipt_reference IS NOT NULL;
