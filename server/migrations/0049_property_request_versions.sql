-- Retain existing requests; versions protect repeated edits and closure/reopening against lost updates.
ALTER TABLE pm_maintenance_requests ADD COLUMN version integer NOT NULL DEFAULT 1 CHECK(version>0);
CREATE FUNCTION pm_request_version_increment() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 NEW.version=OLD.version+1;
 RETURN NEW;
END $$;
CREATE TRIGGER pm_request_version_increment BEFORE UPDATE ON pm_maintenance_requests
 FOR EACH ROW EXECUTE FUNCTION pm_request_version_increment();
