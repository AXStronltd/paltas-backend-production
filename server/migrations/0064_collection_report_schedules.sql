CREATE TABLE pm_collection_report_schedules (
 id text PRIMARY KEY,org_id text NOT NULL REFERENCES organisations(id),property_id text NOT NULL REFERENCES pm_properties(id),
 name text NOT NULL,kind text NOT NULL CHECK(kind IN('receipts','invoices')),format text NOT NULL CHECK(format IN('csv','xlsx','print')),
 frequency text NOT NULL CHECK(frequency IN('daily','weekly','monthly')),hour integer NOT NULL CHECK(hour BETWEEN 0 AND 23),minute integer NOT NULL CHECK(minute BETWEEN 0 AND 59),timezone text NOT NULL,
 status text NOT NULL CHECK(status IN('active','paused','archived')),version integer NOT NULL DEFAULT 1,
 request_key text NOT NULL,updated_by text NOT NULL REFERENCES users(id),created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(org_id,request_key)
);
CREATE INDEX pm_collection_report_schedule_scope ON pm_collection_report_schedules(org_id,property_id,status,id);
CREATE TABLE pm_collection_report_runs (
 id text PRIMARY KEY,org_id text NOT NULL REFERENCES organisations(id),property_id text NOT NULL REFERENCES pm_properties(id),schedule_id text NOT NULL REFERENCES pm_collection_report_schedules(id),
 version integer NOT NULL,from_date date NOT NULL,to_date date NOT NULL,as_of date NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 trigger text NOT NULL CHECK(trigger IN('manual','schedule')),filename text NOT NULL,content text NOT NULL,encoding text NOT NULL CHECK(encoding IN('utf8','base64')),
 content_type text NOT NULL,row_count integer NOT NULL,fingerprint text NOT NULL,UNIQUE(schedule_id,version,from_date,to_date)
);
CREATE INDEX pm_collection_report_run_scope ON pm_collection_report_runs(org_id,schedule_id,created_at DESC,id);
CREATE FUNCTION pm_collection_report_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Prepared collection reports are immutable'; END $$;
CREATE TRIGGER pm_collection_report_immutable BEFORE UPDATE OR DELETE ON pm_collection_report_runs FOR EACH ROW EXECUTE FUNCTION pm_collection_report_immutable();
