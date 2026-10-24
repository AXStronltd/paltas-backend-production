-- Operational dispute records never mutate invoice/payment balances.
ALTER TABLE pm_credit_notes ADD CONSTRAINT pm_credit_note_org_identity UNIQUE(org_id,id);
CREATE TABLE pm_billing_disputes (
 id text PRIMARY KEY,org_id text NOT NULL REFERENCES organisations(id),invoice_id text NOT NULL,
 tenant_id text NOT NULL REFERENCES contacts(id),amount_minor bigint NOT NULL CHECK(amount_minor>0),
 reason text NOT NULL CHECK(length(btrim(reason))>=5),
 status text NOT NULL DEFAULT 'open' CHECK(status IN ('open','reviewing','resolved','rejected','withdrawn')),
 resolution text NOT NULL DEFAULT '',credit_note_id text,
 version integer NOT NULL DEFAULT 1 CHECK(version>0),created_by text NOT NULL REFERENCES users(id),updated_by text NOT NULL REFERENCES users(id),
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(org_id,id),
 FOREIGN KEY(org_id,credit_note_id) REFERENCES pm_credit_notes(org_id,id),
 FOREIGN KEY(org_id,invoice_id) REFERENCES pm_invoices(org_id,id)
);
CREATE UNIQUE INDEX pm_disputes_one_open_invoice ON pm_billing_disputes(org_id,invoice_id) WHERE status IN ('open','reviewing');
CREATE UNIQUE INDEX pm_disputes_credit_once ON pm_billing_disputes(org_id,credit_note_id) WHERE credit_note_id IS NOT NULL;
CREATE INDEX pm_disputes_org_tenant ON pm_billing_disputes(org_id,tenant_id,updated_at DESC,id);
CREATE TABLE pm_billing_dispute_events (
 id text PRIMARY KEY,org_id text NOT NULL REFERENCES organisations(id),dispute_id text NOT NULL,
 action text NOT NULL,reason text NOT NULL,actor_id text NOT NULL REFERENCES users(id),created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(org_id,dispute_id) REFERENCES pm_billing_disputes(org_id,id)
);
CREATE TRIGGER pm_dispute_events_immutable BEFORE UPDATE OR DELETE ON pm_billing_dispute_events FOR EACH ROW EXECUTE FUNCTION audit_log_is_append_only();
