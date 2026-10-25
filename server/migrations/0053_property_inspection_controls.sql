-- Preserve completed inspections; future templates are copied as immutable-in-use snapshots.
CREATE TABLE pm_inspection_templates (
 id text PRIMARY KEY,org_id text NOT NULL REFERENCES organisations(id),property_id text NOT NULL,
 name text NOT NULL,areas jsonb NOT NULL CHECK(jsonb_typeof(areas)='array' AND jsonb_array_length(areas) BETWEEN 1 AND 100),
 active boolean NOT NULL DEFAULT true,version integer NOT NULL DEFAULT 1 CHECK(version>0),
 updated_by text NOT NULL REFERENCES users(id),created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(org_id,property_id) REFERENCES pm_properties(org_id,id),UNIQUE(org_id,id)
);
CREATE UNIQUE INDEX pm_inspection_template_name ON pm_inspection_templates(org_id,property_id,lower(name));
ALTER TABLE pm_inspections ADD COLUMN version integer NOT NULL DEFAULT 1 CHECK(version>0);
ALTER TABLE pm_inspections ADD COLUMN template_id text;
ALTER TABLE pm_inspections ADD COLUMN checklist jsonb NOT NULL DEFAULT '[]' CHECK(jsonb_typeof(checklist)='array');
ALTER TABLE pm_inspections ADD CONSTRAINT pm_inspection_template_org FOREIGN KEY(org_id,template_id) REFERENCES pm_inspection_templates(org_id,id);
ALTER TABLE pm_inspections DROP CONSTRAINT pm_inspections_status_check;
ALTER TABLE pm_inspections ADD CHECK(status IN ('scheduled','completed','cancelled'));
CREATE FUNCTION pm_inspection_version_increment() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.version=OLD.version+1; RETURN NEW; END $$;
CREATE TRIGGER pm_inspection_version_increment BEFORE UPDATE ON pm_inspections
 FOR EACH ROW EXECUTE FUNCTION pm_inspection_version_increment();

ALTER TABLE pm_inspections ADD CONSTRAINT pm_inspection_org_identity UNIQUE(org_id,id);
ALTER TABLE pm_inspections ADD COLUMN followup_of text;
ALTER TABLE pm_inspections ADD CONSTRAINT pm_inspection_followup_org FOREIGN KEY(org_id,followup_of) REFERENCES pm_inspections(org_id,id);
CREATE INDEX pm_inspection_followups ON pm_inspections(org_id,followup_of) WHERE followup_of IS NOT NULL;

-- Shared, scoped record-history lookups avoid scanning an organisation's entire audit trail.
CREATE INDEX audit_log_org_target_history ON audit_log(org_id,target,id DESC) WHERE org_id IS NOT NULL AND target IS NOT NULL;
