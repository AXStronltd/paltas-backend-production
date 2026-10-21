-- A guest's booking request or a buyer's offer can be sent again safely: the browser sends a random request id with
-- the form, and a repeat of the same request returns the same booking or offer (and the same private code) instead of
-- creating another. Additive only: existing rows keep every value (no request id).
ALTER TABLE agency_stays ADD COLUMN request_id text, ADD COLUMN request_quote jsonb;
CREATE UNIQUE INDEX agency_stays_request ON agency_stays (listing_id, request_id) WHERE request_id IS NOT NULL;
ALTER TABLE agency_offers ADD COLUMN request_id text;
CREATE UNIQUE INDEX agency_offers_request ON agency_offers (listing_id, request_id) WHERE request_id IS NOT NULL;
