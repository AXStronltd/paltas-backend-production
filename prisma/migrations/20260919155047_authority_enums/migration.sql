-- ADDING ENUM VALUES, ON THEIR OWN, FIRST.
--
-- Postgres refuses to USE a new enum value in the same transaction that added
-- it ("unsafe use of new value"), and Prisma runs one migration per
-- transaction. The next migration creates tables whose columns DEFAULT to
-- these values, so the values have to be committed before it runs.
--
-- Split by hand for that reason. Nothing here drops or rewrites anything.

ALTER TYPE "DataClass" ADD VALUE 'AUTHORITY_RESTRICTED';
ALTER TYPE "Provenance" ADD VALUE 'DEVELOPER_SUPPLIED';
ALTER TYPE "Provenance" ADD VALUE 'HOTEL_SUPPLIED';
ALTER TYPE "Provenance" ADD VALUE 'AGENT_SUPPLIED';
ALTER TYPE "Provenance" ADD VALUE 'IMPORTED_DOCUMENT';
ALTER TYPE "Provenance" ADD VALUE 'GOVERNMENT';
ALTER TYPE "Provenance" ADD VALUE 'LAND_REGISTRY';
ALTER TYPE "Provenance" ADD VALUE 'PLANNING_AUTHORITY';
ALTER TYPE "TimelineKind" ADD VALUE 'PLANNING_APPROVED';
ALTER TYPE "TimelineKind" ADD VALUE 'PERMIT_ISSUED';
ALTER TYPE "TimelineKind" ADD VALUE 'INSPECTION_PASSED';
ALTER TYPE "TimelineKind" ADD VALUE 'OCCUPANCY_APPROVED';
ALTER TYPE "TimelineKind" ADD VALUE 'ZONING_CHANGED';
ALTER TYPE "TimelineKind" ADD VALUE 'OFFICIAL_NOTICE';
ALTER TYPE "TimelineKind" ADD VALUE 'PARCEL_REGISTERED';
ALTER TYPE "TimelineKind" ADD VALUE 'AUTHORITY_VERIFIED_RECORD';
ALTER TYPE "VerificationState" ADD VALUE 'USER_PROVIDED';
ALTER TYPE "VerificationState" ADD VALUE 'IMPORTED';
ALTER TYPE "VerificationState" ADD VALUE 'AUTHORITY_VERIFIED';
ALTER TYPE "VerificationState" ADD VALUE 'DISPUTED';
ALTER TYPE "VerificationState" ADD VALUE 'EXPIRED';
