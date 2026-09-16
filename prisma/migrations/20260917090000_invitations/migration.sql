-- Invitations: how a second person joins a company.
--
-- Until now the only Membership ever written was the founder's, so every
-- customer was capped at one user and 18 of the 19 roles were unreachable.

CREATE TABLE "Invitation" (
  "id"           TEXT NOT NULL,
  "orgId"        TEXT NOT NULL,
  "email"        TEXT NOT NULL,
  "role"         "Role" NOT NULL,
  "scope"        JSONB NOT NULL DEFAULT '{"all": true}',
  -- SHA-256 only. The link itself is a credential and is never stored.
  "tokenHash"    TEXT NOT NULL,
  "invitedById"  TEXT,
  "expiresAt"    TIMESTAMP(3) NOT NULL,
  "acceptedAt"   TIMESTAMP(3),
  "acceptedById" TEXT,
  "revokedAt"    TIMESTAMP(3),
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"    TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Invitation_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Invitation_tokenHash_key" ON "Invitation"("tokenHash");
CREATE INDEX "Invitation_orgId_idx" ON "Invitation"("orgId");
CREATE INDEX "Invitation_email_idx" ON "Invitation"("email");

-- Deleting a company takes its invitations with it; deleting a person leaves
-- the invitation standing with the pointer dropped, because the record that an
-- invitation was sent and accepted outlives the account that did it.
ALTER TABLE "Invitation" ADD CONSTRAINT "Invitation_orgId_fkey"
  FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Invitation" ADD CONSTRAINT "Invitation_invitedById_fkey"
  FOREIGN KEY ("invitedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Invitation" ADD CONSTRAINT "Invitation_acceptedById_fkey"
  FOREIGN KEY ("acceptedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
