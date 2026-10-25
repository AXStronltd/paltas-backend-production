-- Meter identity and revision metadata only. Existing readings/invoices are not recalculated.
CREATE TABLE pm_utility_meters (
 id text PRIMARY KEY,org_id text NOT NULL REFERENCES organisations(id),unit_id text NOT NULL,charge_type_id text NOT NULL,
 serial text NOT NULL CHECK(length(btrim(serial)) BETWEEN 1 AND 100),from_period char(7) NOT NULL CHECK(from_period ~ '^\d{4}-(0[1-9]|1[0-2])$'),
 opening numeric(14,3) NOT NULL CHECK(opening>=0),through_period char(7) CHECK(through_period ~ '^\d{4}-(0[1-9]|1[0-2])$'),
 closing numeric(14,3),reason text NOT NULL,version integer NOT NULL DEFAULT 1,
 created_by text NOT NULL REFERENCES users(id),created_at timestamptz NOT NULL DEFAULT now(),
 retired_by text REFERENCES users(id),retired_at timestamptz,
 UNIQUE(org_id,id),UNIQUE(org_id,serial),
 FOREIGN KEY(org_id,unit_id) REFERENCES pm_units(org_id,id),FOREIGN KEY(org_id,charge_type_id) REFERENCES pm_charge_types(org_id,id),
 CHECK((through_period IS NULL)=(closing IS NULL)),CHECK(through_period IS NULL OR (through_period>=from_period AND closing>=opening))
);
CREATE UNIQUE INDEX pm_utility_meter_active ON pm_utility_meters(org_id,unit_id,charge_type_id) WHERE through_period IS NULL;
CREATE INDEX pm_utility_meter_unit_period ON pm_utility_meters(org_id,unit_id,charge_type_id,from_period,through_period);
ALTER TABLE pm_meter_readings ADD COLUMN meter_id text;
ALTER TABLE pm_meter_readings ADD COLUMN reading_kind text NOT NULL DEFAULT 'actual' CHECK(reading_kind IN ('actual','estimated'));
ALTER TABLE pm_meter_readings ADD COLUMN reason text NOT NULL DEFAULT '';
ALTER TABLE pm_meter_readings ADD COLUMN version integer NOT NULL DEFAULT 1 CHECK(version>0);
ALTER TABLE pm_meter_readings ADD CONSTRAINT pm_meter_reading_org_identity UNIQUE(org_id,id);
ALTER TABLE pm_meter_readings ADD CONSTRAINT pm_meter_reading_registry FOREIGN KEY(org_id,meter_id) REFERENCES pm_utility_meters(org_id,id);
CREATE TABLE pm_meter_reading_events (
 id text PRIMARY KEY,org_id text NOT NULL REFERENCES organisations(id),reading_id text NOT NULL,
 snapshot jsonb NOT NULL,reason text NOT NULL,actor_id text NOT NULL REFERENCES users(id),created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(org_id,reading_id) REFERENCES pm_meter_readings(org_id,id)
);
CREATE TRIGGER pm_meter_reading_events_immutable BEFORE UPDATE OR DELETE ON pm_meter_reading_events FOR EACH ROW EXECUTE FUNCTION audit_log_is_append_only();
CREATE TABLE pm_utility_meter_events (
 id text PRIMARY KEY,org_id text NOT NULL REFERENCES organisations(id),meter_id text NOT NULL,snapshot jsonb NOT NULL,
 reason text NOT NULL,actor_id text NOT NULL REFERENCES users(id),created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(org_id,meter_id) REFERENCES pm_utility_meters(org_id,id)
);
CREATE TRIGGER pm_utility_meter_events_immutable BEFORE UPDATE OR DELETE ON pm_utility_meter_events FOR EACH ROW EXECUTE FUNCTION audit_log_is_append_only();
CREATE FUNCTION pm_protect_billed_meter_reading() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM pm_invoices i JOIN pm_leases l ON l.id=i.lease_id AND l.org_id=i.org_id WHERE i.org_id=OLD.org_id AND l.unit_id=OLD.unit_id AND i.kind='charge' AND i.recurring AND i.period=OLD.period) THEN
  RAISE EXCEPTION 'Billed meter readings are immutable; use an authorised invoice correction';
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER pm_meter_readings_posted_immutable BEFORE UPDATE OR DELETE ON pm_meter_readings FOR EACH ROW EXECUTE FUNCTION pm_protect_billed_meter_reading();
