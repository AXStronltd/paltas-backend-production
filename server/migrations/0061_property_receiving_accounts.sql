-- Receiving instructions remain unverified until approved provider onboarding is integrated.
-- Preserve versions; never store unencrypted account numbers or claim a saved record enables payouts.
CREATE TABLE pm_receiving_account_versions (
 id text PRIMARY KEY,
 org_id text NOT NULL REFERENCES organisations(id),
 revision integer NOT NULL CHECK(revision>0),
 kind text NOT NULL CHECK(kind IN ('bank','mpesa_mobile','mpesa_paybill','mpesa_till')),
 details_sealed text NOT NULL,
 status text NOT NULL CHECK(status IN ('verification_pending','paused')),
 reason text NOT NULL,
 saved_by text NOT NULL REFERENCES users(id),
 saved_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(org_id,revision)
);
CREATE INDEX pm_receiving_account_latest ON pm_receiving_account_versions(org_id,revision DESC);

CREATE FUNCTION pm_receiving_history_is_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Receiving account history is append-only'; END;
$$;
CREATE TRIGGER pm_receiving_no_rewrite BEFORE UPDATE OR DELETE ON pm_receiving_account_versions
 FOR EACH ROW EXECUTE FUNCTION pm_receiving_history_is_append_only();
