# Property finance operations

## Reused architecture

Supplier bills, contact suppliers, organisation permissions, existing transaction lock, posting service, general ledger, bank reconciliation references, audit log and existing Property Management components are reused. No second ledger or payment provider is introduced.

## New capabilities

- Expenses and Bank Charges use the supplier bill lifecycle: enter, correct while unposted, independently approve, then record an externally completed payment.
- Category and expense account snapshots preserve issued classification. Existing bills retain the previous repairs account; history is not reclassified.
- Bank charges post to the existing bank-charge account. Other operating costs use operating-expense accounts; owner-recoverable costs continue to require management authority and owner-fund accounting.
- Pay Bills opens approved unpaid bills.
- Employee records support repeated editing, archive/restore and optimistic version checks. Historical payslips retain snapshots.
- Kenya payroll drafts, calculations, independent approval, external wage-payment records, separate remittance kinds, payslips, CSV export, cancellation and controlled reversal.
- Salary access requires explicit payroll capabilities. Company administrators can view/prepare; existing finance roles have operational payroll capabilities. Main Managers require owner-delegated permissions. Property-scoped delegates cannot open organisation-wide salaries.
- All writes remain organisation-scoped and use the existing shared financial lock and ledger. Posted entries are not overwritten.

## Schema

0037 adds bill categories/accounts/version, employee records, payroll runs/lines/remittances, payroll link kinds and eight accounts for property subscribers. New subscriptions receive the same accounts through the existing chart-seeding hook. Existing properties, units, tenants, payments, journals and customer credentials are retained. Non-property organisations do not receive the chart additions from this migration.

## Boundaries

See kenya-payroll.md for statutory scope. Banks/M-Pesa salary payments, automated statutory filing, provider remittances and automatic payslip email remain unconnected. Existing approved-bill rejection supplies the established reversal path; paid bill corrections continue to require audited financial reconciliation rather than deletion. Purchase-order bill edits require rejection/re-entry so matching cannot be bypassed. Payroll remittance records currently cover the full selected liability once; partial remittances require future allocation support.
