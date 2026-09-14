-- The prebook pair, persisted the moment a rate is held.
--
-- LiteAPI: "Save transactionId and prebookId together, immediately. Each
-- prebook call generates a new pair, and they cannot be retrieved later."
--
-- prebookId is the idempotency key: unique per supplier, so a retried book
-- returns the existing reservation rather than taking a second room.
--
-- EVERY COLUMN IS NULLABLE OR DEFAULTED, deliberately. An earlier draft
-- added prebookId as NOT NULL with no default; Postgres rejects that on a
-- table that has rows, which would fail the migration, abort npm start and
-- take the API down. A default of '' would be worse — two legacy rows would
-- collide on the unique index.

-- AlterTable
ALTER TABLE "SupplierBooking" ADD COLUMN     "paymentStatus" TEXT NOT NULL DEFAULT 'PENDING',
ADD COLUMN     "prebookId" TEXT,
ADD COLUMN     "transactionId" TEXT NOT NULL DEFAULT '',
ALTER COLUMN "bookingId" DROP NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "SupplierBooking_supplier_prebookId_key" ON "SupplierBooking"("supplier", "prebookId");

