-- Preserve past signed reconciliations. Unapproved legacy snapshots require a fresh preparation.
ALTER TABLE pm_reconciliations ADD COLUMN source_fingerprint text CHECK(source_fingerprint IS NULL OR source_fingerprint ~ '^[0-9a-f]{64}$');
ALTER TABLE pm_reconciliations ADD COLUMN unmatched_count integer CHECK(unmatched_count>=0);
