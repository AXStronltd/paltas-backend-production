-- An existing PALTAS account added to another organisation is INVITED and has no access there until that person
-- accepts (independent review, 14 October 2026: an administrator could otherwise pull any user into their
-- organisation and see their name).
ALTER TABLE memberships DROP CONSTRAINT memberships_status_check;
ALTER TABLE memberships ADD CONSTRAINT memberships_status_check CHECK (status IN ('active', 'suspended', 'invited'));
