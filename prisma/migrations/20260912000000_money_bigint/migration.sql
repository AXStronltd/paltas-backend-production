-- ======================================================================
-- MONEY BECOMES BIGINT.
--
-- WHY, PRECISELY.
--
-- Money in this schema is an INTEGER COUNT OF MINOR UNITS, which is the
-- right decision — 0.1 + 0.2 is not 0.3 in binary floating point, and a rent
-- roll wrong by a cent per row is wrong by real money at the bottom of the
-- page. The mistake was the WIDTH of that integer, not the choice.
--
-- Prisma's `Int` is PostgreSQL INT4. That caps a value at 2,147,483,647
-- minor units:
--
--     INT4 maximum              2,147,483,647 minor  =  KES 21,474,836
--
-- Against the figures this platform actually holds:
--
--     Riverside Court, Nairobi     96,000,000,000 minor   45x over
--     Marina Vista Tower, Dubai   410,000,000,000 minor  190x over
--     Hudson Yards 41, New York   540,000,000,000 minor  250x over
--     a Lavington buyer's budget    5,200,000,000 minor  2.4x over
--
-- So any property worth more than about twenty-one million shillings could
-- not be stored at all. It did not round or truncate — PostgreSQL refused
-- the write and the API returned a 500:
--
--     Unable to fit integer value '5200000000' into an INT4
--
-- Monthly rents fit, which is why this survived: the figures exercised in
-- development were rents, and the figures in the product are valuations.
--
-- BIGINT is INT8 — a ceiling of 9,223,372,036,854,775,807 minor units. The
-- largest real value above is 5.4e11, which leaves roughly seven orders of
-- magnitude of room. This is not a close call.
--
-- ── WHAT THIS MIGRATION DOES AND DOES NOT DO ──────────────────────────
--
-- INT4 -> INT8 is a WIDENING conversion. Every existing value is
-- representable, PostgreSQL rewrites the column in place, and no row is
-- read, reinterpreted or lost. It is not reversible without checking that
-- every value still fits INT4, which is exactly why it is not reversed here.
--
-- `Counter.value` is deliberately NOT in this list. It is a sequence counter
-- for per-company reference numbers (INV-0041), not an amount. Two billion
-- invoices is not a limit worth widening for.
-- ======================================================================

ALTER TABLE "Site"        ALTER COLUMN "value"     SET DATA TYPE BIGINT;

ALTER TABLE "Unit"        ALTER COLUMN "rent"      SET DATA TYPE BIGINT;

ALTER TABLE "Lease"       ALTER COLUMN "rent"      SET DATA TYPE BIGINT,
                          ALTER COLUMN "deposit"   SET DATA TYPE BIGINT;

ALTER TABLE "Project"     ALTER COLUMN "budget"    SET DATA TYPE BIGINT,
                          ALTER COLUMN "spent"     SET DATA TYPE BIGINT;

ALTER TABLE "Reservation" ALTER COLUMN "rate"      SET DATA TYPE BIGINT;

ALTER TABLE "FolioLine"   ALTER COLUMN "amount"    SET DATA TYPE BIGINT;

ALTER TABLE "Listing"     ALTER COLUMN "price"     SET DATA TYPE BIGINT;

ALTER TABLE "Lead"        ALTER COLUMN "budget"    SET DATA TYPE BIGINT;

ALTER TABLE "Deal"        ALTER COLUMN "value"     SET DATA TYPE BIGINT,
                          ALTER COLUMN "fee"       SET DATA TYPE BIGINT;

ALTER TABLE "Invoice"     ALTER COLUMN "total"     SET DATA TYPE BIGINT,
                          ALTER COLUMN "paid"      SET DATA TYPE BIGINT;

ALTER TABLE "InvoiceLine" ALTER COLUMN "unitPrice" SET DATA TYPE BIGINT;

ALTER TABLE "Payment"     ALTER COLUMN "amount"    SET DATA TYPE BIGINT;

ALTER TABLE "Expense"     ALTER COLUMN "amount"    SET DATA TYPE BIGINT;

ALTER TABLE "Payout"      ALTER COLUMN "gross"     SET DATA TYPE BIGINT,
                          ALTER COLUMN "fees"      SET DATA TYPE BIGINT,
                          ALTER COLUMN "net"       SET DATA TYPE BIGINT;
