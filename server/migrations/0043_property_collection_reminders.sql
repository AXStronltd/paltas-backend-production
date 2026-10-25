-- Explicitly configured reminders use the existing transactional notification outbox.
ALTER TABLE pm_properties ADD CONSTRAINT pm_property_org_identity UNIQUE(org_id,id);
CREATE TABLE pm_collection_reminder_policies (
 org_id text NOT NULL REFERENCES organisations(id),property_id text NOT NULL,
 config jsonb NOT NULL CHECK(jsonb_typeof(config)='object'),version integer NOT NULL DEFAULT 1 CHECK(version>0),
 updated_by text NOT NULL REFERENCES users(id),updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(org_id,property_id),FOREIGN KEY(org_id,property_id) REFERENCES pm_properties(org_id,id)
);
CREATE TABLE pm_collection_reminders (
 id text PRIMARY KEY,org_id text NOT NULL REFERENCES organisations(id),property_id text NOT NULL,
 invoice_id text NOT NULL,tenant_id text NOT NULL REFERENCES contacts(id),due_date date NOT NULL,
 stage_days integer NOT NULL,sent_date date NOT NULL,policy_version integer NOT NULL,
 notification_id text NOT NULL REFERENCES notifications(id),created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(org_id,invoice_id,due_date,stage_days),UNIQUE(org_id,invoice_id,sent_date),
 FOREIGN KEY(org_id,property_id) REFERENCES pm_properties(org_id,id),FOREIGN KEY(org_id,invoice_id) REFERENCES pm_invoices(org_id,id)
);
CREATE INDEX pm_collection_reminders_property ON pm_collection_reminders(org_id,property_id,created_at DESC,id);
CREATE TRIGGER pm_collection_reminders_immutable BEFORE UPDATE OR DELETE ON pm_collection_reminders FOR EACH ROW EXECUTE FUNCTION audit_log_is_append_only();
