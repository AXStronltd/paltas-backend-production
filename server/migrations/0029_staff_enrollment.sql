-- No existing account is reset or marked as enrolled by this migration.
ALTER TABLE users ADD COLUMN mfa_confirmed_at timestamptz;
ALTER TABLE users ADD COLUMN mfa_last_step bigint;
-- Disabled, newly provisioned staff may await enrollment. Active staff still require MFA.
ALTER TABLE users DROP CONSTRAINT staff_need_mfa;
ALTER TABLE users ADD CONSTRAINT staff_need_mfa CHECK (staff_role IS NULL OR NOT active OR mfa_secret_sealed IS NOT NULL);
CREATE TABLE staff_enrollments (
 id text PRIMARY KEY,
 user_id text NOT NULL REFERENCES users(id),
 token_hash text NOT NULL UNIQUE,
 email_code_hash text NOT NULL,
 account_fingerprint text NOT NULL,
 approved_by text NOT NULL,
 expires_at timestamptz NOT NULL,
 attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5),
 pending_sealed text,
 used_at timestamptz,
 revoked_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE staff_backup_codes (
 user_id text NOT NULL REFERENCES users(id),
 code_hash text NOT NULL,
 used_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(user_id,code_hash)
);
