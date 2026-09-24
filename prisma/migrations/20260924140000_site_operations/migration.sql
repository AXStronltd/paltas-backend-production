-- CreateEnum
CREATE TYPE "RfiStatus" AS ENUM ('OPEN', 'ANSWERED', 'CLOSED', 'VOID');

-- CreateEnum
CREATE TYPE "SubmittalStatus" AS ENUM ('DRAFT', 'SUBMITTED', 'UNDER_REVIEW', 'APPROVED', 'APPROVED_AS_NOTED', 'REVISE_RESUBMIT', 'REJECTED');

-- CreateEnum
CREATE TYPE "InspectionStatus" AS ENUM ('SCHEDULED', 'PASSED', 'PASSED_WITH_DEFECTS', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "DefectStatus" AS ENUM ('OPEN', 'IN_PROGRESS', 'FIXED', 'VERIFIED', 'REJECTED', 'CLOSED');

-- CreateEnum
CREATE TYPE "DefectSeverity" AS ENUM ('MINOR', 'MAJOR', 'CRITICAL');

-- CreateTable
CREATE TABLE "Rfi" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "ref" TEXT NOT NULL,
    "projectId" TEXT,
    "phaseId" TEXT,
    "subject" TEXT NOT NULL,
    "question" TEXT NOT NULL DEFAULT '',
    "discipline" TEXT NOT NULL DEFAULT '',
    "raisedByName" TEXT NOT NULL DEFAULT '',
    "toName" TEXT NOT NULL DEFAULT '',
    "status" "RfiStatus" NOT NULL DEFAULT 'OPEN',
    "dueOn" TIMESTAMP(3),
    "answer" TEXT NOT NULL DEFAULT '',
    "answeredOn" TIMESTAMP(3),
    "answeredBy" TEXT NOT NULL DEFAULT '',
    "costImpact" TEXT NOT NULL DEFAULT '',
    "timeImpact" TEXT NOT NULL DEFAULT '',
    "createdById" TEXT,
    "createdByName" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Rfi_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Submittal" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "ref" TEXT NOT NULL,
    "projectId" TEXT,
    "title" TEXT NOT NULL,
    "specRef" TEXT NOT NULL DEFAULT '',
    "discipline" TEXT NOT NULL DEFAULT '',
    "contractor" TEXT NOT NULL DEFAULT '',
    "status" "SubmittalStatus" NOT NULL DEFAULT 'DRAFT',
    "revision" INTEGER NOT NULL DEFAULT 0,
    "previousId" TEXT,
    "dueOn" TIMESTAMP(3),
    "submittedOn" TIMESTAMP(3),
    "reviewedOn" TIMESTAMP(3),
    "reviewerName" TEXT NOT NULL DEFAULT '',
    "comments" TEXT NOT NULL DEFAULT '',
    "createdById" TEXT,
    "createdByName" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Submittal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Inspection" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "ref" TEXT NOT NULL,
    "projectId" TEXT,
    "unitId" TEXT,
    "title" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT '',
    "area" TEXT NOT NULL DEFAULT '',
    "status" "InspectionStatus" NOT NULL DEFAULT 'SCHEDULED',
    "scheduledOn" TIMESTAMP(3),
    "inspectedOn" TIMESTAMP(3),
    "inspectorName" TEXT NOT NULL DEFAULT '',
    "notes" TEXT NOT NULL DEFAULT '',
    "createdById" TEXT,
    "createdByName" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Inspection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Defect" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "ref" TEXT NOT NULL,
    "projectId" TEXT,
    "unitId" TEXT,
    "inspectionId" TEXT,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "location" TEXT NOT NULL DEFAULT '',
    "trade" TEXT NOT NULL DEFAULT '',
    "severity" "DefectSeverity" NOT NULL DEFAULT 'MINOR',
    "status" "DefectStatus" NOT NULL DEFAULT 'OPEN',
    "assigneeName" TEXT NOT NULL DEFAULT '',
    "dueOn" TIMESTAMP(3),
    "fixedByName" TEXT NOT NULL DEFAULT '',
    "fixedOn" TIMESTAMP(3),
    "verifiedByName" TEXT NOT NULL DEFAULT '',
    "verifiedOn" TIMESTAMP(3),
    "createdById" TEXT,
    "createdByName" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Defect_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SiteDiary" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "ref" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "on" TIMESTAMP(3) NOT NULL,
    "weather" TEXT NOT NULL DEFAULT '',
    "temperature" TEXT NOT NULL DEFAULT '',
    "labourCount" INTEGER NOT NULL DEFAULT 0,
    "contractors" TEXT NOT NULL DEFAULT '',
    "equipment" TEXT NOT NULL DEFAULT '',
    "workDone" TEXT NOT NULL DEFAULT '',
    "delays" TEXT NOT NULL DEFAULT '',
    "visitors" TEXT NOT NULL DEFAULT '',
    "safetyNotes" TEXT NOT NULL DEFAULT '',
    "materials" TEXT NOT NULL DEFAULT '',
    "lockedAt" TIMESTAMP(3),
    "createdById" TEXT,
    "createdByName" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SiteDiary_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SiteEvent" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "entity" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "detail" TEXT NOT NULL DEFAULT '',
    "byName" TEXT NOT NULL DEFAULT '',
    "rfiId" TEXT,
    "submittalId" TEXT,
    "inspectionId" TEXT,
    "defectId" TEXT,
    "diaryId" TEXT,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SiteEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Rfi_orgId_idx" ON "Rfi"("orgId");

-- CreateIndex
CREATE INDEX "Rfi_orgId_status_idx" ON "Rfi"("orgId", "status");

-- CreateIndex
CREATE INDEX "Rfi_orgId_projectId_idx" ON "Rfi"("orgId", "projectId");

-- CreateIndex
CREATE INDEX "Rfi_orgId_dueOn_idx" ON "Rfi"("orgId", "dueOn");

-- CreateIndex
CREATE UNIQUE INDEX "Rfi_orgId_ref_key" ON "Rfi"("orgId", "ref");

-- CreateIndex
CREATE UNIQUE INDEX "Submittal_previousId_key" ON "Submittal"("previousId");

-- CreateIndex
CREATE INDEX "Submittal_orgId_idx" ON "Submittal"("orgId");

-- CreateIndex
CREATE INDEX "Submittal_orgId_status_idx" ON "Submittal"("orgId", "status");

-- CreateIndex
CREATE INDEX "Submittal_orgId_projectId_idx" ON "Submittal"("orgId", "projectId");

-- CreateIndex
CREATE UNIQUE INDEX "Submittal_orgId_ref_key" ON "Submittal"("orgId", "ref");

-- CreateIndex
CREATE INDEX "Inspection_orgId_idx" ON "Inspection"("orgId");

-- CreateIndex
CREATE INDEX "Inspection_orgId_status_idx" ON "Inspection"("orgId", "status");

-- CreateIndex
CREATE INDEX "Inspection_orgId_projectId_idx" ON "Inspection"("orgId", "projectId");

-- CreateIndex
CREATE UNIQUE INDEX "Inspection_orgId_ref_key" ON "Inspection"("orgId", "ref");

-- CreateIndex
CREATE INDEX "Defect_orgId_idx" ON "Defect"("orgId");

-- CreateIndex
CREATE INDEX "Defect_orgId_status_idx" ON "Defect"("orgId", "status");

-- CreateIndex
CREATE INDEX "Defect_orgId_projectId_idx" ON "Defect"("orgId", "projectId");

-- CreateIndex
CREATE INDEX "Defect_orgId_inspectionId_idx" ON "Defect"("orgId", "inspectionId");

-- CreateIndex
CREATE UNIQUE INDEX "Defect_orgId_ref_key" ON "Defect"("orgId", "ref");

-- CreateIndex
CREATE INDEX "SiteDiary_orgId_idx" ON "SiteDiary"("orgId");

-- CreateIndex
CREATE INDEX "SiteDiary_orgId_projectId_on_idx" ON "SiteDiary"("orgId", "projectId", "on");

-- CreateIndex
CREATE UNIQUE INDEX "SiteDiary_orgId_ref_key" ON "SiteDiary"("orgId", "ref");

-- CreateIndex
CREATE UNIQUE INDEX "SiteDiary_projectId_on_key" ON "SiteDiary"("projectId", "on");

-- CreateIndex
CREATE INDEX "SiteEvent_orgId_idx" ON "SiteEvent"("orgId");

-- CreateIndex
CREATE INDEX "SiteEvent_rfiId_idx" ON "SiteEvent"("rfiId");

-- CreateIndex
CREATE INDEX "SiteEvent_submittalId_idx" ON "SiteEvent"("submittalId");

-- CreateIndex
CREATE INDEX "SiteEvent_inspectionId_idx" ON "SiteEvent"("inspectionId");

-- CreateIndex
CREATE INDEX "SiteEvent_defectId_idx" ON "SiteEvent"("defectId");

-- CreateIndex
CREATE INDEX "SiteEvent_diaryId_idx" ON "SiteEvent"("diaryId");

-- AddForeignKey
ALTER TABLE "Rfi" ADD CONSTRAINT "Rfi_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Rfi" ADD CONSTRAINT "Rfi_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Rfi" ADD CONSTRAINT "Rfi_phaseId_fkey" FOREIGN KEY ("phaseId") REFERENCES "ProjectPhase"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Submittal" ADD CONSTRAINT "Submittal_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Submittal" ADD CONSTRAINT "Submittal_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Submittal" ADD CONSTRAINT "Submittal_previousId_fkey" FOREIGN KEY ("previousId") REFERENCES "Submittal"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Inspection" ADD CONSTRAINT "Inspection_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Inspection" ADD CONSTRAINT "Inspection_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Inspection" ADD CONSTRAINT "Inspection_unitId_fkey" FOREIGN KEY ("unitId") REFERENCES "Unit"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Defect" ADD CONSTRAINT "Defect_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Defect" ADD CONSTRAINT "Defect_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Defect" ADD CONSTRAINT "Defect_unitId_fkey" FOREIGN KEY ("unitId") REFERENCES "Unit"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Defect" ADD CONSTRAINT "Defect_inspectionId_fkey" FOREIGN KEY ("inspectionId") REFERENCES "Inspection"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SiteDiary" ADD CONSTRAINT "SiteDiary_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SiteDiary" ADD CONSTRAINT "SiteDiary_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SiteEvent" ADD CONSTRAINT "SiteEvent_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SiteEvent" ADD CONSTRAINT "SiteEvent_rfiId_fkey" FOREIGN KEY ("rfiId") REFERENCES "Rfi"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SiteEvent" ADD CONSTRAINT "SiteEvent_submittalId_fkey" FOREIGN KEY ("submittalId") REFERENCES "Submittal"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SiteEvent" ADD CONSTRAINT "SiteEvent_inspectionId_fkey" FOREIGN KEY ("inspectionId") REFERENCES "Inspection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SiteEvent" ADD CONSTRAINT "SiteEvent_defectId_fkey" FOREIGN KEY ("defectId") REFERENCES "Defect"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SiteEvent" ADD CONSTRAINT "SiteEvent_diaryId_fkey" FOREIGN KEY ("diaryId") REFERENCES "SiteDiary"("id") ON DELETE CASCADE ON UPDATE CASCADE;

