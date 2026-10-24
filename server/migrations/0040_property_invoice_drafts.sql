-- Drafts are operational records only. Issuance continues to use the existing invoice/ledger service.
ALTER TABLE pm_leases ADD CONSTRAINT pm_lease_org_identity UNIQUE(org_id,id);
ALTER TABLE pm_invoices ADD CONSTRAINT pm_invoice_org_identity UNIQUE(org_id,id);
CREATE TABLE pm_invoice_drafts (
 id text PRIMARY KEY, org_id text NOT NULL REFERENCES organisations(id), lease_id text NOT NULL,
 payload jsonb NOT NULL CHECK(jsonb_typeof(payload)='object'), version integer NOT NULL DEFAULT 1 CHECK(version>0),
 status text NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','approved','issued','archived')),
 created_by text NOT NULL REFERENCES users(id), updated_by text NOT NULL REFERENCES users(id),
 approved_by text REFERENCES users(id), approval_signature text, invoice_id text,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(org_id,lease_id) REFERENCES pm_leases(org_id,id),
 FOREIGN KEY(org_id,invoice_id) REFERENCES pm_invoices(org_id,id),
 CHECK((status='issued')=(invoice_id IS NOT NULL)),
 CHECK(status NOT IN ('approved','issued') OR (approved_by IS NOT NULL AND approval_signature IS NOT NULL)),
 UNIQUE(org_id,invoice_id)
);
CREATE INDEX pm_invoice_drafts_org_status ON pm_invoice_drafts(org_id,status,updated_at DESC,id);

CREATE FUNCTION pm_issued_draft_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.status='issued' THEN RAISE EXCEPTION 'Issued invoice drafts are immutable; use invoice credit/reversal workflows' USING ERRCODE='23514'; END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER pm_issued_draft_immutable BEFORE UPDATE OR DELETE ON pm_invoice_drafts FOR EACH ROW EXECUTE FUNCTION pm_issued_draft_immutable();
