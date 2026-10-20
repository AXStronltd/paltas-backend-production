-- PALTAS platform marketing only. No provider tokens or customer records are stored here.
CREATE TABLE social_campaigns (
  id uuid PRIMARY KEY,
  title text NOT NULL,
  goal text NOT NULL,
  landing_url text NOT NULL,
  posts jsonb NOT NULL,
  status text NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','in_review','approved','scheduled','cancelled')),
  version integer NOT NULL DEFAULT 1 CHECK(version > 0),
  created_by text NOT NULL REFERENCES users(id),
  edited_by text NOT NULL REFERENCES users(id),
  approved_by text REFERENCES users(id),
  scheduled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (status NOT IN ('approved','scheduled') OR (approved_by IS NOT NULL AND approved_by <> edited_by AND approved_by <> created_by)),
  CHECK (status <> 'scheduled' OR scheduled_at IS NOT NULL)
);
CREATE INDEX social_campaigns_schedule ON social_campaigns(status,scheduled_at);
