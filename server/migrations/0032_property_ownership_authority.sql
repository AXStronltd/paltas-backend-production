-- Ownership is independent of a management agreement. Existing property and financial IDs are untouched.
CREATE TABLE pm_ownerships (
 id text PRIMARY KEY,
 org_id text NOT NULL REFERENCES organisations(id),
 property_id text NOT NULL REFERENCES pm_properties(id),
 unit_id text REFERENCES pm_units(id),
 owner_id text NOT NULL REFERENCES contacts(id),
 owner_type text NOT NULL CHECK(owner_type IN ('individual','company')),
 evidence_ref text NOT NULL DEFAULT '',
 note text NOT NULL DEFAULT '',
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','verified','revoked')),
 verified_by text REFERENCES users(id),
 verified_at timestamptz,
 created_by text NOT NULL REFERENCES users(id),
 created_at timestamptz NOT NULL DEFAULT now(),
 CHECK((status='verified') = (verified_by IS NOT NULL AND verified_at IS NOT NULL))
);
CREATE UNIQUE INDEX pm_ownership_scope ON pm_ownerships(property_id,COALESCE(unit_id,'')) WHERE status <> 'revoked';
ALTER TABLE pm_agreements DROP CONSTRAINT pm_agreements_status_check;
ALTER TABLE pm_agreements ADD CONSTRAINT pm_agreements_status_check CHECK(status IN ('draft','active','ended'));
ALTER TABLE pm_agreements ALTER COLUMN status SET DEFAULT 'draft';
ALTER TABLE pm_agreements ADD COLUMN ownership_id text REFERENCES pm_ownerships(id);
ALTER TABLE pm_agreements ADD COLUMN management_model text NOT NULL DEFAULT 'third_party' CHECK(management_model IN ('owner_managed','developer_managed','third_party'));
ALTER TABLE pm_agreements ADD COLUMN management_company text NOT NULL DEFAULT '';
ALTER TABLE pm_agreements ADD COLUMN evidence_ref text NOT NULL DEFAULT '';
ALTER TABLE pm_agreements ADD COLUMN signed_on date;
ALTER TABLE pm_agreements ADD COLUMN approved_by text REFERENCES users(id);
ALTER TABLE pm_agreements ADD COLUMN approved_at timestamptz;

-- Backstop organisation/property boundaries even if another write path is introduced later.
CREATE FUNCTION pm_ownership_scope_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM pm_properties WHERE id=NEW.property_id AND org_id=NEW.org_id)
 OR NOT EXISTS(SELECT 1 FROM contacts WHERE id=NEW.owner_id AND org_id=NEW.org_id)
 OR (NEW.unit_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM pm_units WHERE id=NEW.unit_id AND org_id=NEW.org_id AND property_id=NEW.property_id))
 THEN RAISE EXCEPTION 'Ownership must reference an owner and property or unit in this organisation' USING ERRCODE='PB001'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER pm_ownership_scope_guard BEFORE INSERT OR UPDATE ON pm_ownerships FOR EACH ROW EXECUTE FUNCTION pm_ownership_scope_guard();
CREATE FUNCTION pm_authority_ownership_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.ownership_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM pm_ownerships o WHERE o.id=NEW.ownership_id AND o.org_id=NEW.org_id AND o.property_id=NEW.property_id AND o.owner_id=NEW.owner_id AND (o.unit_id IS NULL OR o.unit_id=NEW.unit_id) AND o.status<>'revoked' AND (NEW.status<>'active' OR o.status='verified'))
 THEN RAISE EXCEPTION 'Management authority does not match verified ownership and coverage' USING ERRCODE='PB001'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER pm_authority_ownership_guard BEFORE INSERT OR UPDATE ON pm_agreements FOR EACH ROW EXECUTE FUNCTION pm_authority_ownership_guard();
