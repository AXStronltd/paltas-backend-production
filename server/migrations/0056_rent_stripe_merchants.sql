-- Company Connect onboarding only. SaaS subscriptions and rent financial records are unchanged.
CREATE TABLE rent_stripe_merchants (
 org_id text PRIMARY KEY REFERENCES organisations(id),
 id text UNIQUE NOT NULL,
 account_id text UNIQUE,
 platform_account_id text NOT NULL,
 country text NOT NULL CHECK(country ~ '^[A-Z]{2}$'),
 model text NOT NULL CHECK(model IN ('landlord','property_manager')),
 mode text NOT NULL CHECK(mode IN ('test','live')),
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','onboarding','restricted','verified')),
 charges_enabled boolean NOT NULL DEFAULT false,
 payouts_enabled boolean NOT NULL DEFAULT false,
 requirements jsonb NOT NULL DEFAULT '[]'::jsonb,
 created_by text NOT NULL REFERENCES users(id),
 created_at timestamptz NOT NULL DEFAULT now(),checked_at timestamptz
);
