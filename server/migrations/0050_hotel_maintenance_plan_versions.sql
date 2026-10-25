-- Preventive plans remain editable, but a scheduler advance cannot be overwritten by a stale form.
ALTER TABLE hotel_maintenance_plans ADD COLUMN version integer NOT NULL DEFAULT 1 CHECK(version>0);
CREATE FUNCTION hotel_maintenance_plan_version_increment() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 NEW.version=OLD.version+1;
 RETURN NEW;
END $$;
CREATE TRIGGER hotel_maintenance_plan_version_increment BEFORE UPDATE ON hotel_maintenance_plans
 FOR EACH ROW EXECUTE FUNCTION hotel_maintenance_plan_version_increment();
