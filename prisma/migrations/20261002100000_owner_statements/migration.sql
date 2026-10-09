-- ======================================================================
-- MANAGING SOMEBODY ELSE'S PROPERTY, AND SAYING SO EVERY MONTH.
--
-- A management agreement (whose property, what fee), the owner statement it
-- produces, and the lines that statement is made of.
--
-- NOTHING EXISTING CHANGES MEANING. A company with no agreements behaves
-- exactly as it did: every property is treated as its own, every rent invoice
-- is its own income, and no statement exists to be issued. The accounting
-- reversal that moves an owner's rent out of the company's income happens only
-- when a statement is issued under an agreement somebody wrote.
--
-- `Payout.agreementId` is nullable and null for every payout that exists: no
-- payout made before today was recorded against an agreement, and nothing that
-- reads payouts today filters on it.
-- ======================================================================

CREATE TYPE "FeeBasis" AS ENUM ('COLLECTED', 'BILLED', 'FIXED');
CREATE TYPE "AgreementStatus" AS ENUM ('DRAFT', 'ACTIVE', 'ENDED');
CREATE TYPE "OwnerStatementLineKind" AS ENUM ('RENT', 'SERVICE_CHARGE', 'OTHER_INCOME', 'COST', 'FEE', 'PAYOUT');

CREATE TABLE "ManagementAgreement" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "ref" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "siteId" TEXT,
    "unitId" TEXT,
    "basis" "FeeBasis" NOT NULL DEFAULT 'COLLECTED',
    "feeBps" INTEGER NOT NULL DEFAULT 0,
    "feeFixed" BIGINT NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL,
    "startsOn" TIMESTAMP(3),
    "endsOn" TIMESTAMP(3),
    "status" "AgreementStatus" NOT NULL DEFAULT 'ACTIVE',
    "note" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ManagementAgreement_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "OwnerStatement" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "ref" TEXT NOT NULL,
    "agreementId" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "periodFrom" TIMESTAMP(3) NOT NULL,
    "periodTo" TIMESTAMP(3) NOT NULL,
    "currency" TEXT NOT NULL,
    "collected" BIGINT NOT NULL DEFAULT 0,
    "billed" BIGINT NOT NULL DEFAULT 0,
    "costs" BIGINT NOT NULL DEFAULT 0,
    "fee" BIGINT NOT NULL DEFAULT 0,
    "net" BIGINT NOT NULL DEFAULT 0,
    "opening" BIGINT NOT NULL DEFAULT 0,
    "paidOut" BIGINT NOT NULL DEFAULT 0,
    "closing" BIGINT NOT NULL DEFAULT 0,
    "costsLeftOff" INTEGER NOT NULL DEFAULT 0,
    "costsLeftOffTotal" BIGINT NOT NULL DEFAULT 0,
    "note" TEXT NOT NULL DEFAULT '',
    "issuedOn" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "issuedById" TEXT NOT NULL DEFAULT '',
    "issuedByName" TEXT NOT NULL DEFAULT '',
    "voided" BOOLEAN NOT NULL DEFAULT false,
    "voidReason" TEXT NOT NULL DEFAULT '',
    "voidedAt" TIMESTAMP(3),
    -- The period while the statement stands, NULL once it is voided. It is
    -- here only so that the unique index below can express "one per period
    -- that has not been voided" — see the note on it, and on the column in
    -- schema.prisma.
    "livePeriodFrom" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OwnerStatement_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "OwnerStatementLine" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "statementId" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL,
    "kind" "OwnerStatementLineKind" NOT NULL,
    "detail" TEXT NOT NULL,
    "amount" BIGINT NOT NULL,
    "sourceType" TEXT NOT NULL DEFAULT '',
    "sourceId" TEXT NOT NULL DEFAULT '',
    "ref" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OwnerStatementLine_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "Payout" ADD COLUMN "agreementId" TEXT;

CREATE UNIQUE INDEX "ManagementAgreement_orgId_ref_key" ON "ManagementAgreement"("orgId", "ref");
CREATE INDEX "ManagementAgreement_orgId_idx" ON "ManagementAgreement"("orgId");
CREATE INDEX "ManagementAgreement_orgId_status_idx" ON "ManagementAgreement"("orgId", "status");
CREATE INDEX "ManagementAgreement_orgId_ownerId_idx" ON "ManagementAgreement"("orgId", "ownerId");
CREATE INDEX "ManagementAgreement_orgId_siteId_idx" ON "ManagementAgreement"("orgId", "siteId");

CREATE UNIQUE INDEX "OwnerStatement_orgId_ref_key" ON "OwnerStatement"("orgId", "ref");
-- One LIVE statement per agreement per period, and that word is why this is an
-- index rather than a unique constraint.
--
-- "Two statements for one month are two different answers to one question" is
-- true of two statements that both still stand. It is not true of a statement
-- that was voided and a corrected one issued in its place -- and voiding then
-- re-issuing is the documented remedy for a statement that was wrong, because
-- the owner is holding a copy and ours cannot simply be edited.
--
-- A plain UNIQUE here could not tell those two cases apart. It counted the
-- voided row, so the month it was issued for was blocked forever: the void
-- succeeded, the correction hit the constraint, and the route answered 500.
-- Postgres can express the real rule as a partial unique index, but Prisma's
-- schema language cannot, and an index schema.prisma does not declare is one
-- the next `prisma migrate dev` silently DROPS. So the rule is enforced in
-- POST /management-agreements/:id/statements, which checks for a statement
-- that is not voided and answers 409 by name, and this index is what makes
-- that check cheap.
CREATE INDEX "OwnerStatement_orgId_agreementId_periodFrom_periodTo_idx" ON "OwnerStatement"("orgId", "agreementId", "periodFrom", "periodTo");
-- ONE STATEMENT PER AGREEMENT PER PERIOD THAT STILL STANDS.
--
-- `livePeriodFrom` holds the period while the statement stands and NULL once
-- it is voided, which is what lets a plain UNIQUE say the real rule. Postgres
-- treats nulls as distinct, so a month may collect any number of voided
-- statements and still hold at most one that stands. The route checks the same
-- thing first and answers 409 by name; this is what stops two requests
-- arriving together from both passing that check.
CREATE UNIQUE INDEX "OwnerStatement_orgId_agreementId_livePeriodFrom_key" ON "OwnerStatement"("orgId", "agreementId", "livePeriodFrom");
CREATE INDEX "OwnerStatement_orgId_ownerId_idx" ON "OwnerStatement"("orgId", "ownerId");
CREATE INDEX "OwnerStatement_orgId_issuedOn_idx" ON "OwnerStatement"("orgId", "issuedOn");

CREATE INDEX "OwnerStatementLine_orgId_statementId_idx" ON "OwnerStatementLine"("orgId", "statementId");

CREATE INDEX "Payout_agreementId_idx" ON "Payout"("agreementId");

-- Restrict on the owner and the agreement: money owed to somebody must not be
-- deletable out from under them. Cascade from the company, as everywhere.
ALTER TABLE "ManagementAgreement" ADD CONSTRAINT "ManagementAgreement_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ManagementAgreement" ADD CONSTRAINT "ManagementAgreement_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "Party"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ManagementAgreement" ADD CONSTRAINT "ManagementAgreement_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ManagementAgreement" ADD CONSTRAINT "ManagementAgreement_unitId_fkey" FOREIGN KEY ("unitId") REFERENCES "Unit"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "OwnerStatement" ADD CONSTRAINT "OwnerStatement_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OwnerStatement" ADD CONSTRAINT "OwnerStatement_agreementId_fkey" FOREIGN KEY ("agreementId") REFERENCES "ManagementAgreement"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "OwnerStatement" ADD CONSTRAINT "OwnerStatement_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "Party"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "OwnerStatementLine" ADD CONSTRAINT "OwnerStatementLine_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OwnerStatementLine" ADD CONSTRAINT "OwnerStatementLine_statementId_fkey" FOREIGN KEY ("statementId") REFERENCES "OwnerStatement"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Payout" ADD CONSTRAINT "Payout_agreementId_fkey" FOREIGN KEY ("agreementId") REFERENCES "ManagementAgreement"("id") ON DELETE SET NULL ON UPDATE CASCADE;
