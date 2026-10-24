-- Repayment arrangements track existing invoices. They never issue invoices or move money.
CREATE TABLE pm_collection_plans (
 id text PRIMARY KEY,org_id text NOT NULL REFERENCES organisations(id),invoice_id text NOT NULL,
 tenant_id text NOT NULL REFERENCES contacts(id),kind text NOT NULL CHECK(kind IN ('repayment','promise')),
 status text NOT NULL DEFAULT 'proposed' CHECK(status IN ('proposed','active','paused','completed','cancelled')),
 schedule jsonb NOT NULL CHECK(jsonb_typeof(schedule)='array'),target_minor bigint NOT NULL CHECK(target_minor>0),
 evidence_ref text NOT NULL,note text NOT NULL DEFAULT '',version integer NOT NULL DEFAULT 1 CHECK(version>0),
 baseline_cash_minor bigint NOT NULL DEFAULT 0 CHECK(baseline_cash_minor>=0),baseline_credit_minor bigint NOT NULL DEFAULT 0 CHECK(baseline_credit_minor>=0),
 closed_settled_minor bigint CHECK(closed_settled_minor>=0 AND closed_settled_minor<=target_minor),approved_by text REFERENCES users(id),
 created_by text NOT NULL REFERENCES users(id),updated_by text NOT NULL REFERENCES users(id),
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(org_id,id),FOREIGN KEY(org_id,invoice_id) REFERENCES pm_invoices(org_id,id),
 CHECK(status NOT IN ('active','paused','completed') OR approved_by IS NOT NULL)
);
CREATE UNIQUE INDEX pm_collection_plan_one_live ON pm_collection_plans(org_id,invoice_id) WHERE status IN ('proposed','active','paused');
CREATE INDEX pm_collection_plan_org_tenant ON pm_collection_plans(org_id,tenant_id,updated_at DESC,id);
CREATE TABLE pm_collection_plan_events (
 id text PRIMARY KEY,org_id text NOT NULL REFERENCES organisations(id),plan_id text NOT NULL,
 action text NOT NULL,reason text NOT NULL,snapshot jsonb NOT NULL CHECK(jsonb_typeof(snapshot)='object'),actor_id text NOT NULL REFERENCES users(id),created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(org_id,plan_id) REFERENCES pm_collection_plans(org_id,id)
);
CREATE TRIGGER pm_collection_plan_events_immutable BEFORE UPDATE OR DELETE ON pm_collection_plan_events FOR EACH ROW EXECUTE FUNCTION audit_log_is_append_only();
