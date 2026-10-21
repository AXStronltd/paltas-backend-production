# Staff first-time enrollment and owner recovery

## Production gate

This release must first pass isolated staging review. Deploying it does **not** reset, disable, enroll or elevate an existing owner. Production deployment and any owner-specific recovery authorization require separate approvals. Never use the earlier temporary Render shell recovery helpers.

## Identity verification and authorization

A public account registration, a chat request, an email address or an email alone is insufficient. An authorized PALTAS operator must authenticate to the correct PALTAS hosting administration, independently verify the owner's identity and authority using the organisation's approved process, and record an approval reference. This process must not be delegated to an unverified caller. The CLI records that hosting-operator authorization; a separate challenge sent to the account's exact mailbox proves mailbox access. The grant file must reach only that verified owner through an approved private channel, separately from the mailbox code. Never put grant links or mailbox codes in support logs or chat.

## Operator command (after review and migrations)

Run inside the correct PALTAS service, using its environment. This command does not apply migrations, seed catalogue data or start background workers.

```
node server/dist/scripts/staff-enrollment-grant.js \
  --email '<independently-verified-owner-email>' \
  --file '/tmp/NEW-owner-private-enrollment.txt' \
  --approval '<authenticated hosting operator and approval reference>' \
  --owner-verified --recover-existing
```

Use `--create-first` instead of `--recover-existing` only on a new installation with no staff and no account using that email. It creates a **disabled**, password-unusable staff account. No client can be elevated. The legacy bootstrap command refuses production execution; its synthetic test-mode path remains for existing test fixtures.

The output file is created once with mode 0600, never overwritten. It contains a 15-minute grant link, not an existing authenticator secret. The eight-digit mailbox challenge is sent separately through the configured platform email adapter. Without a real provider acceptance the transaction rolls back; no grant becomes usable. A failed transaction can leave an unusable private output file, which the operator should remove before retrying with a new filename. At most three grants per account per hour; issuing one supersedes prior unused grants.

## Owner flow

1. Open the private grant link on the canonical configured application origin. The grant fragment is immediately removed from the address/history and is kept only in page memory. If reloading, reopen the privately retained link.
2. Enter the code received in the owner mailbox. This does not create a session or unlock any administrative route.
3. Add the locally generated QR code or manual key to Google Authenticator (TOTP, six digits, 30-second steps). No external QR service receives the key.
4. Enter the first code and choose/confirm a new password privately. Nothing is activated until this code is valid.
5. Save the ten backup codes once, by explicit download or private copying. Acknowledge saving them before continuing.
6. Sign in normally with the new password and a **fresh** authenticator code. The code consumed at activation cannot be replayed. Alternatively use password plus one unused backup code.

Activation locks the grant and account and atomically changes the authorized credentials, marks confirmation time, revokes existing sessions and pending grants, stores only backup hashes and appends an audit event. Roles, memberships, customer records and financial data are preserved. No normal session is issued from the enrollment endpoints. Existing staff accounts and customer MFA are not automatically reclassified by the migration.

## Backup codes and re-enrollment

Codes have 96 random bits each. They require the password and are consumed atomically; simultaneous reuse permits only one session. New enrollment regenerates codes and invalidates the previous set. Recovery grants do not bypass independent identity review. A lost setup response requires a new authorized flow: plaintext codes cannot be recovered from stored hashes.

## Security and delivery boundaries

- Five grant verification attempts and a fifteen-minute expiry; public endpoint rate limits also apply.
- Setup origin is the canonical APP_BASE_URL. For staging, use its configured canonical Netlify origin, not an arbitrary deploy-preview hostname.
- Secrets are encrypted with the environment's SECRETS_KEY. Setup/backup responses are no-store; admin pages send no referrer. No credentials enter browser storage, URLs in requests, analytics or application logs. The grant itself is initially in a fragment, not a query string.
- A database-maintained authentication version prevents activation after a concurrent role, activation, password or authenticator change. Consumed/revoked grants cannot be reused. Replayed TOTP steps are rejected for staff confirmed through this new flow.
- Provider acceptance is **not** delivery proof. Staging acceptance must include actual mailbox receipt before production approval.
- Approval references must contain no secrets or sensitive identity documents.
- Do not enable public signup, change payout/tax settings, or touch Appra for this feature.

## Migration / rollback

Migrations 0029 and 0030 add confirmation/replay/version metadata and isolated staff grant/backup tables. Migration 0029 extends the staff-secret constraint only for disabled staff; active staff still require a stored factor. The migrations perform no owner data reset or backfill claiming confirmation. Keep database backups and deploy backend before frontend. Do not drop the new columns or tables during application rollback; once an owner has enrolled, retain the new identity service to preserve single-use/replay protections. No automatic SQL rollback of owner credentials.
