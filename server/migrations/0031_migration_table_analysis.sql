-- Additive detection metadata. Original bytes remain in mig_files.
ALTER TABLE mig_tables ADD COLUMN analysis jsonb;
