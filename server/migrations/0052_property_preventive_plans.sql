-- Customer-configured servicing plans use existing work orders and the durable core scheduler.
CREATE TABLE pm_preventive_plans (
 id text PRIMARY KEY,org_id text NOT NULL REFERENCES organisations(id),property_id text NOT NULL,
 unit_id text,title text NOT NULL,asset_label text NOT NULL DEFAULT '',
 priority text NOT NULL CHECK(priority IN ('urgent','high','normal','low')),
 every_days integer NOT NULL CHECK(every_days BETWEEN 1 AND 3650),next_due date NOT NULL,
 active boolean NOT NULL DEFAULT true,version integer NOT NULL DEFAULT 1 CHECK(version>0),
 updated_by text NOT NULL REFERENCES users(id),created_at timestamptz NOT NULL DEFAULT now(),last_checked_at timestamptz,
 FOREIGN KEY(org_id,unit_id) REFERENCES pm_units(org_id,id),
 UNIQUE(org_id,id),FOREIGN KEY(org_id,property_id) REFERENCES pm_properties(org_id,id)
);
CREATE INDEX pm_preventive_due ON pm_preventive_plans(org_id,property_id,next_due,id) WHERE active;
CREATE TABLE pm_preventive_occurrences (
 org_id text NOT NULL,plan_id text NOT NULL,due_date date NOT NULL,work_order_id text NOT NULL REFERENCES pm_work_orders(id),
 created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(plan_id,due_date),UNIQUE(work_order_id),
 FOREIGN KEY(org_id,plan_id) REFERENCES pm_preventive_plans(org_id,id)
);
CREATE TRIGGER pm_preventive_occurrences_immutable BEFORE UPDATE OR DELETE ON pm_preventive_occurrences
 FOR EACH ROW EXECUTE FUNCTION audit_log_is_append_only();
