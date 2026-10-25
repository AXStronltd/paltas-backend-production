-- Additive concurrency protection; retain every existing work order and financial relationship.
ALTER TABLE pm_work_orders ADD COLUMN version integer NOT NULL DEFAULT 1 CHECK(version>0);
CREATE FUNCTION pm_work_order_version_increment() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 NEW.version=OLD.version+1;
 RETURN NEW;
END $$;
CREATE TRIGGER pm_work_order_version_increment BEFORE UPDATE ON pm_work_orders
 FOR EACH ROW EXECUTE FUNCTION pm_work_order_version_increment();
