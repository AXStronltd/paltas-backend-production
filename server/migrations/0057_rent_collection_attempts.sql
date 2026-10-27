-- Durable provider attempts, not a second invoice or ledger. No existing financial records are rewritten.
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM ledger_accounts WHERE code IN ('1045','5680') AND NOT system)
 THEN RAISE EXCEPTION 'Provider clearing account codes need review before migration'; END IF;
END $$;
INSERT INTO ledger_accounts(org_id,code,name,type,system)
 SELECT org_id,'1045','Stripe rent collection clearing','asset',true FROM ledger_accounts WHERE code='1040'
 ON CONFLICT(org_id,code) DO NOTHING;
INSERT INTO ledger_accounts(org_id,code,name,type,system)
 SELECT org_id,'5680','Payment processing charges','expense',true FROM ledger_accounts WHERE code='1040'
 ON CONFLICT(org_id,code) DO NOTHING;
CREATE TABLE rent_collection_property_routes (
 org_id text NOT NULL REFERENCES organisations(id),
 property_id text PRIMARY KEY REFERENCES pm_properties(id),
 merchant_id text NOT NULL REFERENCES rent_stripe_merchants(id),
 status text NOT NULL CHECK(status IN ('active','paused')),
 authority_reference text NOT NULL CHECK(length(btrim(authority_reference)) >= 8),
 approved_by text NOT NULL REFERENCES users(id),
 approved_at timestamptz NOT NULL DEFAULT now()
);
CREATE FUNCTION rent_property_route_scope_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM pm_properties p WHERE p.id=NEW.property_id AND p.org_id=NEW.org_id)
 OR NOT EXISTS(SELECT 1 FROM rent_stripe_merchants m WHERE m.id=NEW.merchant_id AND m.org_id=NEW.org_id)
 THEN RAISE EXCEPTION 'Property and collection account must belong to the same workspace' USING ERRCODE='PA003'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER rent_property_route_scope BEFORE INSERT OR UPDATE ON rent_collection_property_routes
 FOR EACH ROW EXECUTE FUNCTION rent_property_route_scope_guard();
CREATE TABLE rent_collection_attempts (
 id text PRIMARY KEY,
 org_id text NOT NULL REFERENCES organisations(id),
 invoice_id text NOT NULL REFERENCES pm_invoices(id),
 tenant_id text NOT NULL REFERENCES contacts(id),
 property_id text NOT NULL REFERENCES pm_properties(id),
 merchant_id text NOT NULL REFERENCES rent_stripe_merchants(id),
 platform_account_id text NOT NULL,
 connected_account_id text NOT NULL,
 mode text NOT NULL CHECK(mode IN ('test','live')),
 method text NOT NULL CHECK(method IN ('card','us_bank_account','bacs_debit','sepa_debit','acss_debit')),
 currency char(3) NOT NULL CHECK(currency ~ '^[A-Z]{3}$'),
 amount_minor bigint NOT NULL CHECK(amount_minor > 0 AND amount_minor <= 9007199254740991),
 request_key text NOT NULL CHECK(length(request_key) BETWEEN 8 AND 120),
 status text NOT NULL DEFAULT 'reserved' CHECK(status IN ('reserved','submitted','processing','succeeded','failed','cancelled','review')),
 provider_session_id text UNIQUE,
 provider_intent_id text UNIQUE,
 payment_id text UNIQUE REFERENCES pm_payments(id),
 verified_success_at timestamptz,
 last_provider_state text,
 clearing_state text NOT NULL DEFAULT 'unsettled' CHECK(clearing_state IN ('unsettled','available','bank_reconciled','disputed','reversed')),
 failure_code text,
 created_by text NOT NULL REFERENCES users(id),
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(org_id,request_key),
 CHECK(payment_id IS NULL OR status IN ('succeeded','review')),
 CHECK(status<>'succeeded' OR payment_id IS NOT NULL)
);
-- A second tab, worker or request cannot reserve the same invoice concurrently.
CREATE UNIQUE INDEX rent_collection_one_pending_invoice ON rent_collection_attempts(invoice_id)
 WHERE status IN ('reserved','submitted','processing') OR (status='review' AND payment_id IS NULL);
CREATE INDEX rent_collection_org_status ON rent_collection_attempts(org_id,status,created_at);
CREATE TABLE rent_collection_provider_events (
 id text PRIMARY KEY,
 attempt_id text NOT NULL REFERENCES rent_collection_attempts(id),
 org_id text NOT NULL REFERENCES organisations(id),
 connected_account_id text NOT NULL,
 event_type text NOT NULL,
 provider_created bigint NOT NULL,
 payload_sha256 text NOT NULL,
 result text NOT NULL,
 received_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE rent_collection_attempt_events (
 id bigserial PRIMARY KEY,
 attempt_id text NOT NULL REFERENCES rent_collection_attempts(id),
 org_id text NOT NULL REFERENCES organisations(id),
 from_status text,
 to_status text NOT NULL,
 reason text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE FUNCTION rent_attempt_event_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Rent collection attempt history is immutable' USING ERRCODE='PA003'; END $$;
CREATE TRIGGER rent_attempt_history_immutable BEFORE UPDATE OR DELETE ON rent_collection_attempt_events
 FOR EACH ROW EXECUTE FUNCTION rent_attempt_event_immutable();
CREATE TRIGGER rent_provider_event_immutable BEFORE UPDATE OR DELETE ON rent_collection_provider_events
 FOR EACH ROW EXECUTE FUNCTION rent_attempt_event_immutable();
-- Reject mismatched organisation/customer/property references even if a future caller omits an application check.
CREATE FUNCTION rent_attempt_scope_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS (SELECT 1 FROM pm_invoices i WHERE i.id=NEW.invoice_id AND i.org_id=NEW.org_id
  AND i.tenant_id=NEW.tenant_id AND i.property_id=NEW.property_id)
 OR NOT EXISTS (SELECT 1 FROM rent_stripe_merchants m WHERE m.id=NEW.merchant_id AND m.org_id=NEW.org_id
  AND m.account_id=NEW.connected_account_id AND m.platform_account_id=NEW.platform_account_id AND m.mode=NEW.mode)
 THEN RAISE EXCEPTION 'Collection references do not belong to one authorised workspace' USING ERRCODE='PA003'; END IF;
 IF TG_OP='UPDATE' AND ROW(NEW.org_id,NEW.invoice_id,NEW.tenant_id,NEW.property_id,NEW.merchant_id,
  NEW.platform_account_id,NEW.connected_account_id,NEW.mode,NEW.method,NEW.currency,NEW.amount_minor,NEW.request_key,NEW.created_by,NEW.created_at)
 IS DISTINCT FROM ROW(OLD.org_id,OLD.invoice_id,OLD.tenant_id,OLD.property_id,OLD.merchant_id,
  OLD.platform_account_id,OLD.connected_account_id,OLD.mode,OLD.method,OLD.currency,OLD.amount_minor,OLD.request_key,OLD.created_by,OLD.created_at)
 THEN RAISE EXCEPTION 'Collection identity and financial terms are immutable' USING ERRCODE='PA003'; END IF;
 IF TG_OP='UPDATE' AND ((OLD.provider_session_id IS NOT NULL AND OLD.provider_session_id IS DISTINCT FROM NEW.provider_session_id)
  OR (OLD.provider_intent_id IS NOT NULL AND OLD.provider_intent_id IS DISTINCT FROM NEW.provider_intent_id)
  OR (OLD.payment_id IS NOT NULL AND OLD.payment_id IS DISTINCT FROM NEW.payment_id))
 THEN RAISE EXCEPTION 'Provider references cannot be replaced' USING ERRCODE='PA003'; END IF;
 IF TG_OP='UPDATE' AND OLD.verified_success_at IS NOT NULL AND OLD.verified_success_at IS DISTINCT FROM NEW.verified_success_at
 THEN RAISE EXCEPTION 'Verified collection confirmation cannot be erased' USING ERRCODE='PA003'; END IF;
 IF NEW.payment_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM pm_payments p WHERE p.id=NEW.payment_id
  AND p.org_id=NEW.org_id AND p.tenant_id=NEW.tenant_id AND p.amount_minor=NEW.amount_minor)
 THEN RAISE EXCEPTION 'Receipt does not match this collection' USING ERRCODE='PA003'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER rent_attempt_scope BEFORE INSERT OR UPDATE ON rent_collection_attempts
 FOR EACH ROW EXECUTE FUNCTION rent_attempt_scope_guard();
