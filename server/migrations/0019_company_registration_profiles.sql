-- Optional for existing accounts; the signup configuration can require complete profiles for new registrations.
-- 0018 is reserved by the independent contact-fields change; this migration does not depend on it.
ALTER TABLE organisations ADD COLUMN registration_profile jsonb
 CHECK(registration_profile IS NULL OR jsonb_typeof(registration_profile)='object');
ALTER TABLE org_signups ADD COLUMN registration_profile jsonb
 CHECK(registration_profile IS NULL OR jsonb_typeof(registration_profile)='object');
