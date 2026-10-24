# Finance controls review — 24 October 2026

## Scope

Review the supplied illustrative utility, payment-state, ownership-split, audit-chain and provider-adapter code against existing PALTAS services. Preserve existing financial records and shared accounting. This is a focused correction, not a claim that the entire universal finance roadmap is complete.

## Existing capabilities reused

| Area                    | Existing implementation                                                                                                                                                             | Decision                                                                                                                                                 |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Utility calculations    | `core/billing/pricing.ts` supports exact BigInt decimal quantities, metered usage, cumulative tier ceilings, finite-tier exhaustion checks, discounts/tax, detached quote snapshots | Reuse; do not create another calculator. Tiered quotes are not a full persisted municipal tariff-management UI.                                          |
| Monthly metered billing | `products/property/billing/billing.service.ts`, lease charge types/readings, transactional invoice posting and per-period duplicate prevention                                      | Replace floating-point monetary rounding with shared exact quote arithmetic.                                                                             |
| Payments                | `core/payments/payments.service.ts`, property allocation/credit services                                                                                                            | Keep transactional event deduplication and existing partial-payment/credit handling. No automatic rejection/refund policy.                               |
| Owner funds             | `products/property/owners/owners.service.ts`, shared ledger/management authority                                                                                                    | Keep ledger-derived statements, contract-based fees, expenses and controlled payouts. Do not infer legal ownership or fee authority from asset labels.   |
| Audit                   | `core/audit/audit.service.ts`, database append-only triggers                                                                                                                        | Preserve existing history. No claim of cryptographic tamper evidence: hash checkpoints/independent anchoring remain a separate design task.              |
| Provider adapters       | `core/payments/adapters/translate.ts`, signature verification, provider services                                                                                                    | Keep exact currency conversion, failed-callback handling, trusted reference lookup and duplicate controls. Live bank/M-Pesa onboarding remains external. |

## Confirmed correction

The monthly property billing path used `Math.round((current - previous) * rateMinor)` while quotes use exact scaled integer arithmetic. For example, 0.3 minus 0.2 at 5 minor units per unit can round to zero in floating-point arithmetic, although the exact half-unit rounds to one. Billing now calls the existing quote engine's metered arithmetic. Missing readings fail explicitly instead of falling back to zero within invoice construction.

Meter storage is `numeric(14,3)`, but input previously accepted arbitrary fractional precision, allowing PostgreSQL to silently round entered readings. The service now rejects more than three decimal places with a charge-specific correction message before saving. Existing readings and issued invoices are not rewritten.

## Supplied examples deliberately not adopted verbatim

- `max_m3` needs unambiguous cumulative ceilings versus band widths. Existing pricing uses cumulative `upTo`, with null for an open final tier.
- An underpayment must not cause an automatic refund or an inferred eviction decision. Refunds require a separately authorised workflow.
- Money must use validated integer minor units and exact calculations rather than unconstrained floating point.
- Internal ownership does not mean operating expenses disappear. Owner remittances must follow legal beneficiaries, agreements, reserves, expenses and reconciled available funds.
- Sorting only root JSON keys is not canonical nested serialization. An unanchored SHA hash chain can be recomputed by an attacker who controls its storage; it is not a substitute for access controls/backups/independent integrity anchoring.
- A callback's arbitrary invoice metadata and amount cannot authorise allocation before provider verification and trusted reference matching.

## Boundaries

No migrations, frontend redesign, live provider activation, automatic refunds, new ownership assignments or changes to existing posted transactions. Persisted tiered tariff configuration and cryptographic audit checkpointing remain follow-up work; this patch does not present them as completed customer workflows.
