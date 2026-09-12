-- ======================================================================
-- A GUEST MAY ASK TO CHECK IN. THEY MAY NOT CHECK THEMSELVES IN.
--
-- Two values on GuestRequestKind, nothing else. The portal needed a way to
-- raise the request; moving the reservation stays with the property, because
-- the room has to be ready, the identity seen and the payment authorised.
-- Naming it CHECK_IN rather than CHECKED_IN is that whole distinction.
--
-- ADDITIVE: two ALTER TYPE ... ADD VALUE. No table touched, no row read or
-- rewritten, nothing dropped.
-- ======================================================================

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "GuestRequestKind" ADD VALUE 'CHECK_IN';
ALTER TYPE "GuestRequestKind" ADD VALUE 'CHECK_OUT';

