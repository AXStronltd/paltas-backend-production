-- Preserve all existing approved settlements. New requests can release only part of held deposits.
ALTER TABLE pm_deposit_refunds ADD COLUMN available_held_minor bigint CHECK(available_held_minor>=held_minor);
DROP INDEX pm_deposit_refunds_open;
CREATE UNIQUE INDEX pm_deposit_refunds_one_requested ON pm_deposit_refunds(org_id,lease_id) WHERE status='requested';
