-- PALTAS's own record of a hotel booking one of its users made through a
-- licensed supplier.
--
-- PURELY ADDITIVE: one new table, two indexes and one foreign key. Nothing
-- existing is altered, renamed or dropped, and no row of production data is
-- read or written by this migration.
--
-- It exists so a booking has an OWNER. Without one, reading or cancelling by
-- booking id could only ask "are you signed in?" — so anybody holding an id
-- could open a stranger's booking or cancel their holiday. That is why those
-- routes were sandbox-only until now.
--
-- It is NOT a cache of supplier content. Hotel names, rates and photographs
-- stay unstored; this is the commercial record of a transaction, which is a
-- different thing and is PALTAS's own.

-- CreateTable
CREATE TABLE "SupplierBooking" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "supplier" TEXT NOT NULL,
    "bookingId" TEXT NOT NULL,
    "clientReference" TEXT NOT NULL DEFAULT '',
    "supplierBookingId" TEXT NOT NULL DEFAULT '',
    "hotelConfirmationCode" TEXT NOT NULL DEFAULT '',
    "hotelId" TEXT NOT NULL DEFAULT '',
    "hotelName" TEXT NOT NULL DEFAULT '',
    "city" TEXT NOT NULL DEFAULT '',
    "country" TEXT NOT NULL DEFAULT '',
    "checkIn" TIMESTAMP(3),
    "checkOut" TIMESTAMP(3),
    "nights" INTEGER NOT NULL DEFAULT 1,
    "price" BIGINT NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "status" TEXT NOT NULL DEFAULT 'CONFIRMED',
    "refundable" BOOLEAN,
    "cancelledAt" TIMESTAMP(3),
    "cancellationFee" BIGINT,
    "refund" BIGINT,
    "sandbox" BOOLEAN NOT NULL DEFAULT false,
    "holderName" TEXT NOT NULL DEFAULT '',
    "holderEmail" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SupplierBooking_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SupplierBooking_userId_createdAt_idx" ON "SupplierBooking"("userId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "SupplierBooking_supplier_bookingId_key" ON "SupplierBooking"("supplier", "bookingId");

-- AddForeignKey
ALTER TABLE "SupplierBooking" ADD CONSTRAINT "SupplierBooking_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

