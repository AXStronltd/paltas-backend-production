# Invoice payment links — 29 October 2026

Extends the existing invoice, receiving-account, payment and ledger services. No replacement billing engine, payment provider configuration change or new pooled wallet.

## Implemented
- Owner confirms a saved, encrypted receiving destination for sharing as manual instructions (bank, M-Pesa mobile, PayBill or Till). This is business confirmation, not provider verification.
- Authorised finance operators create a private invoice link, choose expiry (1–14 days), copy it and revoke it. No email is automatically sent.
- Random 256-bit token in URL fragment; database stores only its SHA-256 hash. Public APIs receive it in POST bodies, return no-store/no-referrer headers and enforce rate limits.
- Every access rechecks original operator's current organisation/product permissions and property scope, subscription, organisation status, expiry and revocation.
- Customer sees current invoice balance and confirmed receiving instructions. Updated/paused receiving details invalidate old instructions. No tenant identity or unrelated record is exposed.
- Customer M-Pesa prompt uses the existing client-owned connector only when enabled and eligible. Pending is not paid; provider status must be verified before shared receipt/ledger posting. Whole-shilling checks prevent provider rounding up.
- No invoice, payment, notification, bank verification or payout is created merely by registering details or making a link.

## Migration
0062 adds receiving-instruction confirmations and expiring invoice-link metadata. Existing financial records are preserved. Revert application before considering any schema rollback; never delete collected financial facts.

## Verification
Focused six-suite backend run: 42 passed. Manager connector DOM checks: 52 passed. Public-page DOM checks cover token transport, changing balance, revoked instructions, XSS-safe rendering, pending and recorded states. Desktop/mobile browser uses explicitly synthetic API responses; no live provider payment was made. Receiving-account browser integration uses isolated PostgreSQL and real HTTP. Full regression and release evidence recorded separately.

## Remaining gates
Automatic client merchant onboarding and direct settlement require the provider's actual platform/submerchant contract/API. Public collection/wallet APIs do not establish this capability. Live execution remains gated; this release does not enable automatic bank payouts. Manual instructions require customers to pay in their own bank/M-Pesa application and finance staff to verify the transfer. One primary receiving destination per organisation; it is not multiple simultaneous destinations. No provider refund/payout execution or real-money acceptance is certified by these tests.
