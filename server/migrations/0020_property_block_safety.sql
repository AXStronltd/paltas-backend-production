-- Preserve historical records when hiding blocks. No existing records are removed.
ALTER TABLE pm_buildings ADD COLUMN is_archived boolean NOT NULL DEFAULT false;
ALTER TABLE pm_units ADD COLUMN toilets integer CHECK (toilets BETWEEN 0 AND 50);
CREATE INDEX pm_units_building ON pm_units(building_id);

-- The building row is the serialization point for archive, unit placement and lease activation.
CREATE FUNCTION pm_block_archive_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE active_count integer;
BEGIN
  IF NEW.is_archived AND NOT OLD.is_archived THEN
    SELECT count(*) INTO active_count FROM pm_leases l JOIN pm_units u ON u.id=l.unit_id
      WHERE u.building_id=NEW.id AND l.status='active';
    IF active_count>0 THEN
      RAISE EXCEPTION USING ERRCODE='PB001', MESSAGE=format('Cannot delete this block. It currently has %s active leases. Please terminate all leases first.',active_count);
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER pm_block_archive_guard BEFORE UPDATE ON pm_buildings FOR EACH ROW EXECUTE FUNCTION pm_block_archive_guard();

CREATE FUNCTION pm_block_unit_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE block_row pm_buildings%ROWTYPE;
BEGIN
  IF NEW.building_id IS NOT NULL THEN
    SELECT * INTO block_row FROM pm_buildings WHERE id=NEW.building_id FOR SHARE;
    IF NOT FOUND OR block_row.org_id<>NEW.org_id OR block_row.property_id<>NEW.property_id THEN
      RAISE EXCEPTION USING ERRCODE='PB001', MESSAGE='That block is not in this property';
    END IF;
    IF block_row.is_archived THEN
      RAISE EXCEPTION USING ERRCODE='PB001', MESSAGE='This block is archived. Choose an active block.';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER pm_block_unit_insert BEFORE INSERT ON pm_units FOR EACH ROW EXECUTE FUNCTION pm_block_unit_guard();
CREATE TRIGGER pm_block_unit_move BEFORE UPDATE OF building_id, property_id, org_id ON pm_units FOR EACH ROW
 WHEN (OLD.building_id IS DISTINCT FROM NEW.building_id OR OLD.property_id IS DISTINCT FROM NEW.property_id OR OLD.org_id IS DISTINCT FROM NEW.org_id)
 EXECUTE FUNCTION pm_block_unit_guard();

CREATE FUNCTION pm_block_lease_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE archived boolean;
BEGIN
  -- A terminated historical lease can still be read and reconciled after archiving.
  IF TG_OP='UPDATE' THEN
    IF NEW.unit_id=OLD.unit_id AND NEW.status<>'active' THEN RETURN NEW; END IF;
  END IF;
  PERFORM 1 FROM pm_units WHERE id=NEW.unit_id FOR SHARE;
  SELECT b.is_archived INTO archived FROM pm_units u JOIN pm_buildings b ON b.id=u.building_id
    WHERE u.id=NEW.unit_id FOR SHARE OF b;
  IF archived THEN
    RAISE EXCEPTION USING ERRCODE='PB001', MESSAGE='This block is archived. New or active leases are not allowed.';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER pm_block_lease_guard BEFORE INSERT OR UPDATE OF unit_id, status ON pm_leases
 FOR EACH ROW EXECUTE FUNCTION pm_block_lease_guard();
