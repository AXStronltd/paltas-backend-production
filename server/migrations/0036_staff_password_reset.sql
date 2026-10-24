-- Additive recovery records only; existing users, MFA and sessions are unchanged.
CREATE TABLE staff_password_resets (
 id text PRIMARY KEY,
 user_id text NOT NULL REFERENCES users(id),
 token_hash text NOT NULL UNIQUE,
 account_version bigint NOT NULL,
 expires_at timestamptz NOT NULL,
 attempts integer NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 5),
 used_at timestamptz,
 superseded_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX staff_password_resets_user ON staff_password_resets(user_id,created_at);
CREATE TABLE staff_reset_requests (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 ip_hash text NOT NULL,
 email_hash text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX staff_reset_requests_ip ON staff_reset_requests(ip_hash,created_at);
CREATE INDEX staff_reset_requests_email ON staff_reset_requests(email_hash,created_at);
