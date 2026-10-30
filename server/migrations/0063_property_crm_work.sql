CREATE TABLE pm_crm_work (
 id text PRIMARY KEY,org_id text NOT NULL REFERENCES organisations(id),property_id text NOT NULL REFERENCES pm_properties(id),contact_id text REFERENCES contacts(id),
 title text NOT NULL,description text NOT NULL DEFAULT '',kind text NOT NULL CHECK(kind IN('task','call','meeting')),due_at timestamptz NOT NULL,
 priority text NOT NULL CHECK(priority IN('low','normal','high','urgent')),assignee_id text NOT NULL REFERENCES users(id),
 status text NOT NULL DEFAULT 'open' CHECK(status IN('open','completed','cancelled','archived')),version integer NOT NULL DEFAULT 1,
 request_key text NOT NULL,created_by text NOT NULL REFERENCES users(id),created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(org_id,request_key)
);
CREATE INDEX pm_crm_work_scope ON pm_crm_work(org_id,property_id,status,due_at,id);
CREATE TABLE pm_crm_work_history (
 task_id text NOT NULL REFERENCES pm_crm_work(id),version integer NOT NULL,at timestamptz NOT NULL DEFAULT now(),actor text NOT NULL,reason text NOT NULL,snapshot jsonb NOT NULL,PRIMARY KEY(task_id,version)
);
CREATE FUNCTION pm_crm_history_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'CRM revision history is immutable'; END $$;
CREATE TRIGGER pm_crm_history_immutable BEFORE UPDATE OR DELETE ON pm_crm_work_history FOR EACH ROW EXECUTE FUNCTION pm_crm_history_immutable();
