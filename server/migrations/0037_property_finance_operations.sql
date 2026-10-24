-- Additive operational finance records; no existing financial postings are changed.
ALTER TABLE pm_bills ADD COLUMN expense_category text NOT NULL DEFAULT 'repairs' CHECK(expense_category IN ('repairs','utilities','cleaning','security','administration','bank_charges','other'));
ALTER TABLE pm_bills ADD COLUMN expense_account text NOT NULL DEFAULT '5650';
ALTER TABLE pm_bills ADD COLUMN version integer NOT NULL DEFAULT 1;
CREATE TABLE pm_employees (
 id text PRIMARY KEY, org_id text NOT NULL REFERENCES organisations(id), code text NOT NULL, name text NOT NULL,
 email text, gross_minor bigint NOT NULL CHECK(gross_minor>0), active boolean NOT NULL DEFAULT true,
 version integer NOT NULL DEFAULT 1, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(org_id,code)
);
CREATE TABLE pm_payroll_runs (
 id text PRIMARY KEY, org_id text NOT NULL REFERENCES organisations(id), period text NOT NULL CHECK(period ~ '^2026-(0[2-9]|1[0-2])$'),
 status text NOT NULL CHECK(status IN ('draft','approved','paid','cancelled','reversed')),
 version integer NOT NULL DEFAULT 1, prepared_by text NOT NULL, approved_by text, paid_by text,
 approved_on date, paid_on date, paid_reference text, journal_id text, payment_journal_id text,
 created_at timestamptz NOT NULL DEFAULT now(), CHECK(approved_by IS NULL OR approved_by<>prepared_by)
);
CREATE UNIQUE INDEX pm_payroll_one_live_period ON pm_payroll_runs(org_id,period) WHERE status NOT IN ('cancelled','reversed');
CREATE TABLE pm_payroll_lines (
 run_id text NOT NULL REFERENCES pm_payroll_runs(id), employee_id text NOT NULL REFERENCES pm_employees(id),
 employee_code text NOT NULL, employee_name text NOT NULL, inputs jsonb NOT NULL, calculation jsonb NOT NULL,
 PRIMARY KEY(run_id,employee_id)
);
CREATE TABLE pm_payroll_remittances (
 id text PRIMARY KEY, run_id text NOT NULL REFERENCES pm_payroll_runs(id), kind text NOT NULL CHECK(kind IN ('PAYE','NSSF','SHIF','AHL','NITA','pension','medical','other_employee','other_employer')),
 amount_minor bigint NOT NULL CHECK(amount_minor>0), paid_on date NOT NULL, reference text NOT NULL, recorded_by text NOT NULL, journal_id text NOT NULL,
 UNIQUE(run_id,kind)
);
-- PM-specific payroll accounts use the same organisation ledger. No owner/client funds are used.
INSERT INTO ledger_accounts(org_id,code,name,type,system)
SELECT o.id,a.code,a.name,a.type,true FROM organisations o CROSS JOIN (VALUES
 ('5670','Property payroll wages','expense'),('5671','Property employer payroll contributions','expense'),
 ('2670','Property net wages payable','liability'),('2671','Property PAYE payable','liability'),
 ('2672','Property NSSF payable','liability'),('2673','Property SHIF payable','liability'),
 ('2674','Property housing levy payable','liability'),('2675','Property other payroll deductions payable','liability')
) AS a(code,name,type) WHERE EXISTS(SELECT 1 FROM subscriptions s WHERE s.org_id=o.id AND s.product='property') ON CONFLICT(org_id,code) DO NOTHING;
ALTER TABLE pm_ledger_links DROP CONSTRAINT pm_ledger_links_kind_check;
ALTER TABLE pm_ledger_links ADD CONSTRAINT pm_ledger_links_kind_check CHECK(kind IN ('invoice','receipt','collection','credit_note','deposit_refund','bill','bill_payment','payout','payroll','payroll_payment','payroll_remittance','payroll_reversal'));
