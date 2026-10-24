-- Shared internal activity provenance. No profile scoring, marketing enrolment, access changes or financial posting.
ALTER TABLE contact_activities ADD COLUMN source_product text CHECK(source_product IN ('property','developer','agency','hotel','security'));
ALTER TABLE contact_activities ADD COLUMN event_type text;
ALTER TABLE contact_activities ADD COLUMN event_key text;
ALTER TABLE contact_activities ADD CONSTRAINT contact_activity_provenance_complete CHECK(
 (source_product IS NULL AND event_type IS NULL AND event_key IS NULL) OR
 (source_product IS NOT NULL AND event_type IS NOT NULL AND event_key IS NOT NULL)
);
CREATE UNIQUE INDEX contact_activity_product_event ON contact_activities(org_id,source_product,event_key) WHERE event_key IS NOT NULL;
CREATE INDEX contact_activity_product_timeline ON contact_activities(org_id,contact_id,source_product,at DESC);
