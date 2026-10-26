-- Keep archived relationship history when duplicate contact identities are merged.
-- Only one current relationship of each kind may exist for a contact on a lease.
ALTER TABLE pm_lease_people DROP CONSTRAINT pm_lease_people_org_id_lease_id_contact_id_kind_key;
CREATE UNIQUE INDEX pm_lease_people_active_identity ON pm_lease_people(org_id,lease_id,contact_id,kind) WHERE NOT archived;
