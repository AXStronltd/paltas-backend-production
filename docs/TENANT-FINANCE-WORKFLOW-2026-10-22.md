# Tenant finance workflow — 22 October 2026

## Scope and root causes

Existing deposit services already support lease move-out, arrears allocation, reasoned deductions, independent approval, ledger posting and bank reconciliation. They record refunds; they do not transfer money. Existing receipt corrections preserve the original postings and require independent approval. Unpaid invoice corrections use credit notes. These rules are retained.

The tenant profile did not summarise balances or expose its invoices, receipts and lease actions as a connected financial workflow. Invoice delivery did not have a property-billing endpoint: general contact messages were recorded only. Deposit approval did not display a confirmation breakdown.

## Changes

- Tenant profile: outstanding, overdue, due today or later, paid against invoices and deposit-held totals, based on authorised server records. Deposits remain separate from paid rent.
- Open invoices and receipts from the profile. Record payment with the tenant preselected. Bill an active lease filtered to this tenant. Review or request corrections through existing capability checks.
- Lease actions and move-out/deposit settlement remain in the same profile. Settlement history shows refund reference, amount, status and independent review actions.
- Approval preview identifies tenant/unit, deposit, arrears, deductions/reasons, refund and reference. Actual transfers remain outside PALTAS; the UI says this explicitly.
- Invoice email preview and confirmation endpoints require the finance module and property.billing capability. Recipient comes from the invoice's organisation-scoped contact; callers cannot supply arbitrary recipients, content or sender addresses.
- Email permission is required on the tenant contact; notification-outbox opt-outs also apply. Staff can record the tenant's preference and its evidence/source, then return to the invoice preview.
- Invoice amount, dates, lines, currency, recipient and organisation are hashed into a preview key. A changed balance or recipient requires a new preview. Finance operations are serialised per organisation. Retried confirmation of an identical preview reuses one outbox record and never creates another invoice.
- Confirmed tenant invoice emails use source property_invoice and the configured PALTAS transactional email provider. Existing platform-security emails and other products retain their delivery behaviour. General contact messages remain recorded-only.
- The existing outbox scheduler dispatches the email. Recorded, sent (provider accepted), delivered, suppressed, failed and bounced remain distinct. Delivery is never asserted without provider evidence.

## Data and security

No migration, new dependency, customer-data rewrite, production financial posting, refund, email or bank transfer is part of this release procedure. No permission was broadened. Closed-period rules and the existing independent financial-approval rules remain intact. No changes to Marketplace presentation, Stripe, Appra or other client workflows. Generated API bundles on other HTML pages change mechanically only.

## User workflow

1. Open tenant profile to see due/paid totals, invoices, receipts, deposit and leases.
2. Open an invoice, select Email invoice, review the registered address and amounts, then explicitly confirm. If missing, correct email/contact permission and return to the preview.
3. For a mistake, credit the unpaid invoice balance or request reversal of the incorrect receipt. Another authorised person approves a receipt reversal before a corrected payment is recorded.
4. At move-out, end the lease, request deposit settlement, review arrears/deductions/refund, obtain independent approval, arrange the actual transfer through the bank/M-Pesa, and reconcile its reference.

## Limits

No automatic bank/M-Pesa payout integration is introduced. Invoice emails are text summaries, not a new jurisdiction-specific tax invoice/PDF engine. Invoice email sending is manual; monthly billing does not silently email every tenant. One identical invoice snapshot is sent once; temporary provider failures use the existing retry policy. Permanent failures/bounces need operational review; no bulk resend/reminder feature is added. SMS and WhatsApp invoice sending are not included. Real production delivery is not proven by fake-provider tests. Posted financial history cannot be hard-deleted or silently overwritten; drafts and corrections use existing allowed workflows.

## Verification

- Final complete backend run: 119 files / 758 tests passed (266.49 seconds).
- Earlier whole-suite attempts encountered local timeouts, including dependent audit failures. Failed suites passed a serial recheck (36 tests). The final whole-suite run above passed without increasing timeout limits; a process-scoped idle-sleep inhibitor was used during that run.
- Targeted invoice email, provider adapter and property acceptance: 32 tests passed; the final full run also includes the seventh invoice-email test.
- Property Management browser journey: 115 checks passed, including refund preview/approval and settlement visibility on the tenant profile.
- Tenant profile/portal/browser correction flow: 27 checks passed, including mobile viewport and email-preference return navigation.
- Configured-email browser path: 26 checks passed. It records an email in the actual outbox; scheduler disabled and provider URL local-only. No real message sent.
- TypeScript, backend ESLint, formatting, generated browser-client parity, frontend syntax/basic ESLint, generated HTML parity and production build passed.
- Desktop and mobile screenshots reviewed using synthetic test records. Tables preserve horizontal scrolling on narrow screens. Tenant wizard and finance overview checks passed; the legacy workflow test exited successfully with known jsdom external-navigation warnings.
- Non-PM generated page changes were checked to be API-bundle replacement only: Marketplace, admin, account, Agent, Developer, Hotel and Security markup and styling remain unchanged.

## Release gate

This update is implemented and tested but not deployed. No production data or hosting configuration has changed in this assignment. Production deployment requires the owner's explicit release approval under the earlier PALTAS release rules. Backend must be released before the frontend because the UI calls two new invoice email endpoints. No database migration is required. Existing finance history, role checks, bank reconciliation and independent approvals must remain enabled.
