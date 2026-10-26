-- Additional household/emergency relationships are operational records, never rent liability or sign-in grants.
ALTER TABLE contacts ADD CONSTRAINT contacts_org_identity UNIQUE(org_id,id);
CREATE TABLE pm_lease_people (
 id text PRIMARY KEY,org_id text NOT NULL REFERENCES organisations(id),lease_id text NOT NULL,contact_id text NOT NULL,
 kind text NOT NULL CHECK(kind IN ('occupant','emergency_contact')),
 relationship text NOT NULL DEFAULT '',note text NOT NULL DEFAULT '',
 start_date date,end_date date,archived boolean NOT NULL DEFAULT false,
 version integer NOT NULL DEFAULT 1 CHECK(version>0),created_by text NOT NULL REFERENCES users(id),
 created_at timestamptz NOT NULL DEFAULT now(),
 CHECK(end_date IS NULL OR start_date IS NULL OR end_date>=start_date),
 FOREIGN KEY(org_id,lease_id) REFERENCES pm_leases(org_id,id),
 FOREIGN KEY(org_id,contact_id) REFERENCES contacts(org_id,id),
 UNIQUE(org_id,lease_id,contact_id,kind)
);
CREATE INDEX pm_lease_people_lease ON pm_lease_people(org_id,lease_id,archived,id);
CREATE INDEX pm_lease_people_contact ON pm_lease_people(org_id,contact_id,lease_id);
CREATE FUNCTION pm_lease_people_version_increment() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.version=OLD.version+1; RETURN NEW; END $$;
CREATE TRIGGER pm_lease_people_version_increment BEFORE UPDATE ON pm_lease_people
 FOR EACH ROW EXECUTE FUNCTION pm_lease_people_version_increment();
