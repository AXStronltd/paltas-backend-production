-- CRM activity is separate from binding reservations and contracts. Final sales stages remain derived from records.
ALTER TABLE dev_contacts ADD COLUMN pipeline_stage text
  CHECK (pipeline_stage IN ('enquiry','contacted','site_visit'));
ALTER TABLE dev_contacts ADD COLUMN pipeline_version integer NOT NULL DEFAULT 0 CHECK (pipeline_version >= 0);
CREATE TABLE dev_onboarding_campaign (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton), eligible_after timestamptz NOT NULL DEFAULT now()
);
INSERT INTO dev_onboarding_campaign(singleton) VALUES(true);
CREATE TABLE dev_setup_alerts (
  id text PRIMARY KEY, org_id text NOT NULL REFERENCES organisations(id), user_id text NOT NULL REFERENCES users(id),
  step text NOT NULL CHECK(step IN ('project','leads','budget')), title text NOT NULL, message text NOT NULL,
  action_route text NOT NULL CHECK(action_route IN ('projects','devmigrate','cost')),
  created_at timestamptz NOT NULL DEFAULT now(), read_at timestamptz, dismissed_at timestamptz,
  UNIQUE(org_id,user_id,step)
);
CREATE INDEX dev_setup_alerts_person ON dev_setup_alerts(org_id,user_id,created_at DESC);
-- Public project pages require explicit publication; no customer project is exposed by migration.
CREATE TABLE dev_public_projects (
  project_id text PRIMARY KEY REFERENCES dev_projects(id), org_id text NOT NULL REFERENCES organisations(id),
  slug text NOT NULL UNIQUE, published boolean NOT NULL DEFAULT false, published_by text REFERENCES users(id),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE dev_project_enquiries (
 id text PRIMARY KEY, org_id text NOT NULL REFERENCES organisations(id),project_id text NOT NULL REFERENCES dev_projects(id),
 buyer_id text NOT NULL REFERENCES dev_contacts(id),message text NOT NULL,contact_consent boolean NOT NULL CHECK(contact_consent),
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX dev_project_enquiries_project ON dev_project_enquiries(org_id,project_id,created_at DESC);
