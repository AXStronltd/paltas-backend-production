-- PALTAS staff roles for the Super Admin portal (additive: the two existing roles keep their meaning).
--   super_admin  everything; operations, finance, moderator, marketing: one area of changes each; support: view only.
ALTER TABLE users DROP CONSTRAINT users_staff_role_check;
ALTER TABLE users ADD CONSTRAINT users_staff_role_check
  CHECK (staff_role IN ('super_admin', 'operations', 'finance', 'moderator', 'marketing', 'support'));

-- when the person last signed in (staff team list, client directory); NULL = not since this column existed
ALTER TABLE users ADD COLUMN last_sign_in_at timestamptz;
