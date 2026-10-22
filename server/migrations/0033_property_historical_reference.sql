-- Historical reference records never post to the live ledger or create current charges/payments.
CREATE TABLE pm_historical_records (
 id text PRIMARY KEY,
 org_id text NOT NULL REFERENCES organisations(id),
 property_id text NOT NULL REFERENCES pm_properties(id),
 unit_id text REFERENCES pm_units(id),
 unit_label text,
 record_kind text NOT NULL CHECK(record_kind IN ('service_charge_summary','rent_summary','payment_summary','balance_summary','expense_summary')),
 period text NOT NULL CHECK(period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
 source_subject text NOT NULL,
 subject_type text NOT NULL CHECK(subject_type IN ('tenant','owner')),
 amount_minor bigint NOT NULL,
 currency text NOT NULL,
 source_workbook text NOT NULL,
 source_worksheet text NOT NULL,
 source_cell text NOT NULL,
 source_system text NOT NULL,
 source_record_id text NOT NULL,
 mig_job_id text NOT NULL REFERENCES mig_jobs(id),
 mig_batch_id text NOT NULL REFERENCES mig_batches(id),
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(org_id,source_system,source_record_id),
 UNIQUE(org_id,property_id,unit_id,record_kind,period)
);
CREATE FUNCTION pm_history_reference_scope() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE matches integer;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM pm_properties WHERE id=NEW.property_id AND org_id=NEW.org_id) THEN RAISE EXCEPTION 'Historical property is not in this organisation' USING ERRCODE='PB001'; END IF;
 IF btrim(COALESCE(NEW.unit_label,''))<>'' THEN
  SELECT count(*),min(u.id) INTO matches,NEW.unit_id FROM pm_units u WHERE u.org_id=NEW.org_id AND u.property_id=NEW.property_id
    AND regexp_replace(regexp_replace(upper(u.unit_no),'\s','','g'),'^0+','')=regexp_replace(regexp_replace(upper(NEW.unit_label),'\s','','g'),'^0+','');
  IF matches<>1 THEN RAISE EXCEPTION 'Historical unit % must match exactly one saved apartment in this property',NEW.unit_label USING ERRCODE='PB001'; END IF;
 ELSIF NEW.record_kind<>'expense_summary' THEN RAISE EXCEPTION 'Historical unit is required for this monthly summary' USING ERRCODE='PB001'; END IF;
 IF NEW.unit_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM pm_units WHERE id=NEW.unit_id AND org_id=NEW.org_id AND property_id=NEW.property_id) THEN RAISE EXCEPTION 'Historical unit belongs to a different property or organisation' USING ERRCODE='PB001'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER pm_history_reference_scope BEFORE INSERT OR UPDATE ON pm_historical_records FOR EACH ROW EXECUTE FUNCTION pm_history_reference_scope();
