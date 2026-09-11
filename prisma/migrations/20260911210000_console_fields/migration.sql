-- ======================================================================
-- PALTAS API — the fields the built console actually collects.
--
-- `contract/backend.md` §2 lists all 27 create forms in the product with
-- the exact fields each one posts. Checking the API against that table,
-- form by form, turned up eleven values the console shows and asks for
-- that had no column anywhere to put them.
--
-- They are added rather than dropped. A form that appears to save and
-- silently loses a value is the worst of the three possible outcomes: the
-- customer sees no error, believes the record is complete, and finds out
-- later that it is not.
--
-- EVERY COLUMN HERE IS NOT NULL WITH A DEFAULT, so this file is safe
-- against a database that already holds rows.
--
-- WHY SOME OF THESE LOOK DENORMALISED, because they do and it is
-- deliberate: `Lease.tenantName` sits beside `Lease.tenantId`, and
-- `Unit.buildingName` beside `Unit.buildingId`. The console's forms
-- collect a typed name before a picker exists, and often before the
-- tenant or building is a record at all. The relation stays the truth
-- once it is set; the text is what was actually typed, and losing it
-- would lose the only thing the person entered.
-- ======================================================================

-- A site, as the `portfolio` screen shows it: how many units, what it is
-- worth. `unitCount` rather than `units` because `Site.units` is already
-- the relation to the unit records.
ALTER TABLE "Site" ADD COLUMN "unitCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Site" ADD COLUMN "value"     INTEGER NOT NULL DEFAULT 0;

-- A resident, from `s_residents`: which unit they live in, how many cars.
ALTER TABLE "Party" ADD COLUMN "unit" TEXT    NOT NULL DEFAULT '';
ALTER TABLE "Party" ADD COLUMN "cars" INTEGER NOT NULL DEFAULT 0;

-- The building as typed on the `units` form.
ALTER TABLE "Unit" ADD COLUMN "buildingName" TEXT NOT NULL DEFAULT '';

-- Tenant and unit as typed on the `rentals` form.
ALTER TABLE "Lease" ADD COLUMN "tenantName" TEXT NOT NULL DEFAULT '';
ALTER TABLE "Lease" ADD COLUMN "unitRef"    TEXT NOT NULL DEFAULT '';

-- `ag_bookings` names a property; `h_reservations` types a room number
-- before the room record is chosen.
ALTER TABLE "Reservation" ADD COLUMN "property"   TEXT NOT NULL DEFAULT '';
ALTER TABLE "Reservation" ADD COLUMN "roomNumber" TEXT NOT NULL DEFAULT '';

-- Which property a `sales` lead is asking about.
ALTER TABLE "Lead" ADD COLUMN "property" TEXT NOT NULL DEFAULT '';

-- "Mondays, 08:00-12:00" — a rule in words. validFrom and validTo stay for
-- passes issued against real dates.
ALTER TABLE "Pass" ADD COLUMN "valid" TEXT NOT NULL DEFAULT '';
