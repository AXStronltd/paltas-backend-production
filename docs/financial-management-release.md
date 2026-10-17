# Property Management financial management candidate

## Shared accounting

All products post to the organisation's existing double-entry ledger. PM rent collected on behalf of an owner, refundable deposits and tenant credit are not company revenue. Company management fees, agency charges and company costs use separate ledger accounts.

Existing server workflows cover rent/charges/deposits, partial allocations and credit, receivables and arrears, supplier bills with approvals, maintenance costs, owner statements and payouts, bank reconciliation, journals with a second approver, closed accounting periods and audit logs.

## New receipt correction

- `POST /api/v1/orgs/:orgId/property/payments/:paymentId/reversal` with `{reason}` requests correction.
- `POST .../reversal/approve` requires a different authorised user.
- `POST .../reversal/reject` with `{reason}` rejects a pending request. A later new request is audited separately.
- No receipt, original allocation or posted journal is deleted. Mirror journals and a reversal record restore effective invoice balances. The original receipt/reference stays reserved.
- Bank-matched receipts, used credit, insufficient owner funds, pending owner payouts, dependent deposit settlements and closed posting periods prevent unsafe correction.
- This corrects a bookkeeping entry. It does not refund money or initiate a bank/card/mobile-money transaction.
- The correction posts on its approval date. Historic collections stay in the original period and the correction is a signed negative collection in its approval period.
- Original and correction entries both remain in tenant statements and audit history.
- Product journals cannot be reversed through the generic manual-journal endpoint; source records must stay consistent with accounting.

Migration `0020_payment_corrections.sql` adds the correction table, effective read views, updated allocation-limit trigger and payment page index. It does not delete existing records. Test and stage before production; preserve the prior backend and database backup before release. A code rollback after corrections must retain the new effective read semantics; do not revert to software that counts reversed receipts as effective money.

## Payment paging

`GET .../payments?limit=50&offset=0` returns payments, total, limit and offset. Limit is 1–200; offset is bounded. Pages use deterministic newest-first ordering and a repeatable-read snapshot. Receipt detail uses the existing single-payment endpoint. Legacy complete-list callers remain compatible; this is not a guarantee that every historical export is memory bounded.

## Frontend reporting

Financial management reads opening/closing trial balances and account activity through authenticated APIs. It shows company income, expenditure, net result, financial position and bank account movements. Aged payables includes approved unpaid supplier bills; pending approvals and bills without due dates are explicitly separated. Accounting checks compare source balances with the shared ledger.

Bank movements include transfers and corrections and are not a formal operating/investing/financing cash-flow statement. Tax filing, payroll, live payment collection and automatic bank execution are not implemented by this candidate and must remain unavailable until their own integration is verified.

## Scale and release limits

The page test covers 1,000 synthetic receipts and bounded returned rows, not production throughput. Property financial writes use a transaction-level lock per organisation, keeping dependency checks and postings together without blocking other organisations. Benchmark throughput within one large company before a high-concurrency release. Other legacy finance lists still need a separate pagination/volume audit.

Only isolated development/staging deployment is authorised for this candidate. Production migration/deployment and public signup changes need explicit approval. GitHub required checks must not be bypassed.
