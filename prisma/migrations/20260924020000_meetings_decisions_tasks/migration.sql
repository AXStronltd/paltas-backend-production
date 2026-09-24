-- CreateEnum
CREATE TYPE "MeetingKind" AS ENUM ('SITE', 'DESIGN', 'PROGRESS', 'COMMERCIAL', 'BOARD', 'CLIENT', 'OTHER');

-- CreateEnum
CREATE TYPE "MeetingStatus" AS ENUM ('SCHEDULED', 'HELD', 'CANCELLED');

-- CreateEnum
CREATE TYPE "DecisionStatus" AS ENUM ('OPEN', 'UNDER_REVIEW', 'APPROVED', 'REJECTED', 'IMPLEMENTED', 'CLOSED');

-- CreateEnum
CREATE TYPE "TaskStatus" AS ENUM ('TODO', 'IN_PROGRESS', 'BLOCKED', 'DONE', 'CANCELLED');

-- CreateEnum
CREATE TYPE "TaskPriority" AS ENUM ('LOW', 'NORMAL', 'HIGH', 'URGENT');

-- CreateTable
CREATE TABLE "Meeting" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "ref" TEXT NOT NULL,
    "projectId" TEXT,
    "title" TEXT NOT NULL,
    "kind" "MeetingKind" NOT NULL DEFAULT 'PROGRESS',
    "status" "MeetingStatus" NOT NULL DEFAULT 'SCHEDULED',
    "startsAt" TIMESTAMP(3),
    "endsAt" TIMESTAMP(3),
    "location" TEXT NOT NULL DEFAULT '',
    "videoUrl" TEXT NOT NULL DEFAULT '',
    "agenda" TEXT NOT NULL DEFAULT '',
    "minutes" TEXT NOT NULL DEFAULT '',
    "minutesSentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Meeting_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MeetingParticipant" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "meetingId" TEXT NOT NULL,
    "partyId" TEXT,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL DEFAULT '',
    "role" TEXT NOT NULL DEFAULT '',
    "attended" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MeetingParticipant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Decision" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "ref" TEXT NOT NULL,
    "projectId" TEXT,
    "meetingId" TEXT,
    "subject" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "options" TEXT NOT NULL DEFAULT '',
    "decision" TEXT NOT NULL DEFAULT '',
    "area" TEXT NOT NULL DEFAULT '',
    "ownerName" TEXT NOT NULL DEFAULT '',
    "status" "DecisionStatus" NOT NULL DEFAULT 'OPEN',
    "decidedOn" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Decision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DecisionEvent" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "decisionId" TEXT NOT NULL,
    "status" "DecisionStatus" NOT NULL,
    "note" TEXT NOT NULL DEFAULT '',
    "byName" TEXT NOT NULL DEFAULT '',
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DecisionEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Task" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "ref" TEXT NOT NULL,
    "projectId" TEXT,
    "unitId" TEXT,
    "meetingId" TEXT,
    "decisionId" TEXT,
    "leadId" TEXT,
    "parentId" TEXT,
    "title" TEXT NOT NULL,
    "detail" TEXT NOT NULL DEFAULT '',
    "assigneeId" TEXT,
    "assigneeName" TEXT NOT NULL DEFAULT '',
    "priority" "TaskPriority" NOT NULL DEFAULT 'NORMAL',
    "status" "TaskStatus" NOT NULL DEFAULT 'TODO',
    "dueOn" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdById" TEXT,
    "createdByName" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Task_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TaskChecklistItem" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "done" BOOLEAN NOT NULL DEFAULT false,
    "position" INTEGER NOT NULL DEFAULT 0,
    "doneAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TaskChecklistItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TaskComment" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "byName" TEXT NOT NULL DEFAULT '',
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TaskComment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Meeting_orgId_idx" ON "Meeting"("orgId");

-- CreateIndex
CREATE INDEX "Meeting_orgId_projectId_idx" ON "Meeting"("orgId", "projectId");

-- CreateIndex
CREATE INDEX "Meeting_orgId_startsAt_idx" ON "Meeting"("orgId", "startsAt");

-- CreateIndex
CREATE UNIQUE INDEX "Meeting_orgId_ref_key" ON "Meeting"("orgId", "ref");

-- CreateIndex
CREATE INDEX "MeetingParticipant_orgId_idx" ON "MeetingParticipant"("orgId");

-- CreateIndex
CREATE INDEX "MeetingParticipant_orgId_meetingId_idx" ON "MeetingParticipant"("orgId", "meetingId");

-- CreateIndex
CREATE INDEX "Decision_orgId_idx" ON "Decision"("orgId");

-- CreateIndex
CREATE INDEX "Decision_orgId_projectId_idx" ON "Decision"("orgId", "projectId");

-- CreateIndex
CREATE INDEX "Decision_orgId_status_idx" ON "Decision"("orgId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Decision_orgId_ref_key" ON "Decision"("orgId", "ref");

-- CreateIndex
CREATE INDEX "DecisionEvent_orgId_decisionId_idx" ON "DecisionEvent"("orgId", "decisionId");

-- CreateIndex
CREATE INDEX "Task_orgId_idx" ON "Task"("orgId");

-- CreateIndex
CREATE INDEX "Task_orgId_status_idx" ON "Task"("orgId", "status");

-- CreateIndex
CREATE INDEX "Task_orgId_assigneeId_idx" ON "Task"("orgId", "assigneeId");

-- CreateIndex
CREATE INDEX "Task_orgId_dueOn_idx" ON "Task"("orgId", "dueOn");

-- CreateIndex
CREATE INDEX "Task_orgId_projectId_idx" ON "Task"("orgId", "projectId");

-- CreateIndex
CREATE UNIQUE INDEX "Task_orgId_ref_key" ON "Task"("orgId", "ref");

-- CreateIndex
CREATE INDEX "TaskChecklistItem_orgId_taskId_idx" ON "TaskChecklistItem"("orgId", "taskId");

-- CreateIndex
CREATE INDEX "TaskComment_orgId_taskId_idx" ON "TaskComment"("orgId", "taskId");

-- AddForeignKey
ALTER TABLE "Meeting" ADD CONSTRAINT "Meeting_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Meeting" ADD CONSTRAINT "Meeting_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MeetingParticipant" ADD CONSTRAINT "MeetingParticipant_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MeetingParticipant" ADD CONSTRAINT "MeetingParticipant_meetingId_fkey" FOREIGN KEY ("meetingId") REFERENCES "Meeting"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MeetingParticipant" ADD CONSTRAINT "MeetingParticipant_partyId_fkey" FOREIGN KEY ("partyId") REFERENCES "Party"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Decision" ADD CONSTRAINT "Decision_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Decision" ADD CONSTRAINT "Decision_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Decision" ADD CONSTRAINT "Decision_meetingId_fkey" FOREIGN KEY ("meetingId") REFERENCES "Meeting"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DecisionEvent" ADD CONSTRAINT "DecisionEvent_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DecisionEvent" ADD CONSTRAINT "DecisionEvent_decisionId_fkey" FOREIGN KEY ("decisionId") REFERENCES "Decision"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_unitId_fkey" FOREIGN KEY ("unitId") REFERENCES "Unit"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_meetingId_fkey" FOREIGN KEY ("meetingId") REFERENCES "Meeting"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_decisionId_fkey" FOREIGN KEY ("decisionId") REFERENCES "Decision"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "Task"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_assigneeId_fkey" FOREIGN KEY ("assigneeId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskChecklistItem" ADD CONSTRAINT "TaskChecklistItem_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskChecklistItem" ADD CONSTRAINT "TaskChecklistItem_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskComment" ADD CONSTRAINT "TaskComment_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskComment" ADD CONSTRAINT "TaskComment_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE CASCADE ON UPDATE CASCADE;

