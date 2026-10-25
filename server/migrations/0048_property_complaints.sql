-- Operational cases: no financial or occupancy mutation. Evidence stays in private document storage.
CREATE TABLE pm_complaints (
 id text PRIMARY KEY, org_id text NOT NULL REFERENCES organisations(id),
 lease_id text NOT NULL, title text NOT NULL CHECK(length(btrim(title)) BETWEEN 3 AND 160),
 category text NOT NULL CHECK(length(btrim(category)) BETWEEN 2 AND 80),
 description text NOT NULL CHECK(length(btrim(description)) BETWEEN 5 AND 2000),
 status text NOT NULL DEFAULT 'open' CHECK(status IN ('open','reviewing','escalated','resolved','closed')),
 assigned_user_id text, resolution text NOT NULL DEFAULT '',
 version integer NOT NULL DEFAULT 1 CHECK(version>0),
 created_by text NOT NULL REFERENCES users(id), updated_by text NOT NULL REFERENCES users(id),
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(org_id,id),
 FOREIGN KEY(org_id,lease_id) REFERENCES pm_leases(org_id,id),
 FOREIGN KEY(org_id,assigned_user_id) REFERENCES memberships(org_id,user_id)
);
CREATE INDEX pm_complaints_org_updated ON pm_complaints(org_id,updated_at DESC,id);
CREATE INDEX pm_complaints_lease ON pm_complaints(org_id,lease_id,status);
CREATE TABLE pm_complaint_events (
 id text PRIMARY KEY, org_id text NOT NULL REFERENCES organisations(id), complaint_id text NOT NULL,
 action text NOT NULL, reason text NOT NULL, internal boolean NOT NULL DEFAULT false,
 actor_id text NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(org_id,complaint_id) REFERENCES pm_complaints(org_id,id)
);
CREATE INDEX pm_complaint_events_case ON pm_complaint_events(org_id,complaint_id,created_at,id);
CREATE TRIGGER pm_complaint_events_immutable BEFORE UPDATE OR DELETE ON pm_complaint_events
 FOR EACH ROW EXECUTE FUNCTION audit_log_is_append_only();
CREATE TABLE pm_complaint_evidence (
 org_id text NOT NULL REFERENCES organisations(id), complaint_id text NOT NULL, document_id text NOT NULL,
 created_by text NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(org_id,complaint_id,document_id), FOREIGN KEY(org_id,document_id) REFERENCES pm_documents(org_id,id), FOREIGN KEY(org_id,complaint_id) REFERENCES pm_complaints(org_id,id)
);
CREATE TRIGGER pm_complaint_evidence_immutable BEFORE UPDATE OR DELETE ON pm_complaint_evidence
 FOR EACH ROW EXECUTE FUNCTION audit_log_is_append_only();
