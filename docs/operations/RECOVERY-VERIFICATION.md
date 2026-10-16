# PALTAS recovery verification — 16 October 2026

## Verified infrastructure

Production database: Render `dpg-db89pdnavr4c73ao3g0g-a` (`paltas-v2-db`), PostgreSQL 16, Frankfurt, 15 GB, available. No production record was changed by this verification.

Render's authenticated recovery API reported `AVAILABLE`, with the recoverable window beginning 15 October 2026 at 09:41:06 UTC. This is the observed window, not a promise that an older restore point exists. Provider documentation states that paid databases have PITR and logical exports are retained for seven days: https://render.com/docs/postgresql-backups.

A new managed logical export was requested and completed at **16 October 2026, 13:28 UTC (16:28 Nairobi)**. It was downloaded privately and restored with `pg_restore --exit-on-error --no-owner --no-privileges` into a **new local recovery-only database**, never the Supabase staging database and never production.

- Restore time: **1.08 seconds**, on the current local machine and current small database only; this is not a production RTO.
- Restored public tables: **286**.
- Restored rows: **953**.
- Applied migrations in the export: **13**.
- Unbalanced recovered journals: **0**.
- Aggregate SHA256 of sorted table/row representations: `ef210059f77df9d73eb2043a14831a5cd768279ded00d4e3361ea28d1f403715`.
- The restored database contains no customer organisations, properties, leases or registrations and no known sample-email users. The single existing staff account was not changed.

The isolated automated recovery test additionally creates posted financial entries and private document bytes, restores a fresh database, and compares every public table's row fingerprints and financial totals. These synthetic records exercise data types not yet present in the production export.

## Recovery procedure

1. Record the incident and obtain an authorised recovery decision. Pause affected writes if necessary, with explicit production approval. Never restore over the live database as a test.
2. Inspect Render's Recovery page/API for the available PITR interval and export timestamps. For accidental data loss, select a recoverable point before the incident; logical exports may be older.
3. Create a separate recovery instance. A hosted instance may incur costs and needs the owner's approval. Retain the original instance and protect credentials.
4. Restore without starting the API, email dispatcher, billing scheduler or other workers against the recovery copy. Restrict access to the recovery personnel.
5. Verify migration status, all expected tables, row counts/fingerprints where a source snapshot is available, balanced posted journals, invoice totals, private-file checksums and company boundaries. Record actual recovery-point age and elapsed restoration/validation time.
6. Reapply any verified erasure instructions that post-date the recovery point. Do not send queued emails or repeat business jobs during validation.
7. Prepare the connection-string change, rollback and reconciliation plan. Obtain explicit production cutover approval before changing the live service. Update secrets directly in Render, never in Git or chat.
8. Verify live health, migration readiness, account access and reconciled records after approved cutover. Keep the old database protected until rollback retention is agreed. Deleting production or recovery data requires a separate authorised retention/deletion decision.

## Ongoing operations

Check the available recovery window and latest export before each release and regularly during operation. Investigate missing/failed backups. Maintain protected exports for any retention longer than Render's seven-day logical-export period. No additional cloud storage or paid recovery instance has been purchased or configured by this verification.
