-- Additive only. Existing roles, memberships, leases and ledger records are unchanged.
CREATE TABLE main_manager_grants (
 org_id text NOT NULL, user_id text NOT NULL, product text NOT NULL,
 capabilities text[] NOT NULL DEFAULT '{}', property_ids text[], enabled boolean NOT NULL DEFAULT true,
 updated_by text NOT NULL REFERENCES users(id), updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(org_id,user_id,product), FOREIGN KEY(org_id,user_id) REFERENCES memberships(org_id,user_id)
);
CREATE TABLE pm_tenant_controls (
 org_id text NOT NULL REFERENCES organisations(id), tenant_id text NOT NULL REFERENCES contacts(id),
 portal_suspended boolean NOT NULL DEFAULT false, archived boolean NOT NULL DEFAULT false,
 reason text NOT NULL DEFAULT '', review_on date, updated_by text NOT NULL REFERENCES users(id),
 updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(org_id,tenant_id)
);
