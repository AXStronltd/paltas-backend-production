ALTER TABLE users ADD COLUMN auth_version bigint NOT NULL DEFAULT 0;
-- Invalidate grants on actual credential/access changes, including changes from existing administration paths.
CREATE FUNCTION advance_staff_auth_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (NEW.password_hash, NEW.mfa_secret_sealed, NEW.staff_role, NEW.active, NEW.email)
    IS DISTINCT FROM (OLD.password_hash, OLD.mfa_secret_sealed, OLD.staff_role, OLD.active, OLD.email) THEN
  NEW.auth_version := OLD.auth_version + 1;
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER users_auth_version BEFORE UPDATE OF password_hash,mfa_secret_sealed,staff_role,active,email ON users
FOR EACH ROW EXECUTE FUNCTION advance_staff_auth_version();

-- Earlier development grants are superseded; existing credentials and sessions remain intact.
UPDATE staff_enrollments SET revoked_at=now(),pending_sealed=NULL WHERE used_at IS NULL AND revoked_at IS NULL;
ALTER TABLE staff_enrollments ADD COLUMN account_version bigint NOT NULL DEFAULT 0;
ALTER TABLE staff_enrollments ADD COLUMN allow_disabled boolean NOT NULL DEFAULT false;
ALTER TABLE staff_enrollments DROP COLUMN account_fingerprint;
