-- Payment plans: the schedule a buyer agreed to, which the contract never held.
-- The invariant the tables exist for is that instalments add up to the price
-- EXACTLY — the last one carries whatever the division left over.

CREATE TYPE "PaymentPlanKind" AS ENUM ('TIME_BASED', 'CONSTRUCTION_LINKED');

CREATE TABLE "PaymentPlan" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "contractId" TEXT NOT NULL,
    "kind" "PaymentPlanKind" NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'KES',
    "depositBp" INTEGER NOT NULL DEFAULT 0,
    "supersededAt" TIMESTAMP(3),
    "supersededBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "PaymentPlan_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PaymentInstalment" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "description" TEXT NOT NULL,
    "amount" BIGINT NOT NULL,
    "dueOn" TIMESTAMP(3),
    "milestone" TEXT,
    "invoiceId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "PaymentInstalment_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CostCode" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "projectId" TEXT,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "CostCode_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "PaymentPlan_orgId_idx" ON "PaymentPlan"("orgId");
CREATE INDEX "PaymentPlan_orgId_contractId_supersededAt_idx"
    ON "PaymentPlan"("orgId", "contractId", "supersededAt");
CREATE INDEX "PaymentInstalment_orgId_idx" ON "PaymentInstalment"("orgId");
CREATE INDEX "PaymentInstalment_orgId_dueOn_invoiceId_idx"
    ON "PaymentInstalment"("orgId", "dueOn", "invoiceId");
CREATE INDEX "PaymentInstalment_orgId_milestone_idx"
    ON "PaymentInstalment"("orgId", "milestone");
CREATE UNIQUE INDEX "PaymentInstalment_planId_seq_key" ON "PaymentInstalment"("planId", "seq");

-- ONE INSTALMENT IS INVOICED AT MOST ONCE. The constraint, not a handler
-- check — this is how a buyer ends up billed twice for the same stage.
CREATE UNIQUE INDEX "PaymentInstalment_invoiceId_key" ON "PaymentInstalment"("invoiceId");

CREATE INDEX "CostCode_orgId_idx" ON "CostCode"("orgId");
CREATE INDEX "CostCode_orgId_active_idx" ON "CostCode"("orgId", "active");
CREATE UNIQUE INDEX "CostCode_orgId_projectId_code_key"
    ON "CostCode"("orgId", "projectId", "code");

ALTER TABLE "PaymentPlan" ADD CONSTRAINT "PaymentPlan_orgId_fkey"
    FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PaymentPlan" ADD CONSTRAINT "PaymentPlan_contractId_fkey"
    FOREIGN KEY ("contractId") REFERENCES "Contract"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PaymentInstalment" ADD CONSTRAINT "PaymentInstalment_orgId_fkey"
    FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PaymentInstalment" ADD CONSTRAINT "PaymentInstalment_planId_fkey"
    FOREIGN KEY ("planId") REFERENCES "PaymentPlan"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- SET NULL: voiding an invoice frees the instalment to be invoiced again, and
-- must not delete the instalment itself.
ALTER TABLE "PaymentInstalment" ADD CONSTRAINT "PaymentInstalment_invoiceId_fkey"
    FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "CostCode" ADD CONSTRAINT "CostCode_orgId_fkey"
    FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- SET NULL, not CASCADE: projectId is optional, so a code can stand alone. A
-- closed project leaves its codes company-wide rather than destroying them and
-- the history posted against them.
ALTER TABLE "CostCode" ADD CONSTRAINT "CostCode_projectId_fkey"
    FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE SET NULL ON UPDATE CASCADE;
