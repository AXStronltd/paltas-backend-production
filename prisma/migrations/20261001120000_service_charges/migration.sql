-- THE OTHER THING A TENANT PAYS EVERY PERIOD.
--
-- Security, cleaning, water, lifts, the generator, insurance — the costs of the
-- BUILDING rather than of the unit. A property company's second revenue line
-- after rent, and until now PALTAS had no way to bill it.
--
-- Kept apart from `rent` rather than folded into it, because a landlord's rent
-- roll and a tenant's total bill are different questions, and because the two
-- are governed differently: rent is negotiated, a service charge is meant to be
-- the tenant's share of what the building actually cost. A company that raised
-- the rent to cover the lift would be unable to answer either question.
--
-- NOT a "service" in the operational sense — that is a catalogue item somebody
-- performs. This is a financial charge against a tenancy.
--
-- Defaulting to 0 leaves every existing lease billing exactly what it bills
-- today. Nothing starts charging because a column appeared.
ALTER TABLE "Lease" ADD COLUMN "serviceCharge" BIGINT NOT NULL DEFAULT 0;

-- WHAT WAS CHARGED, BESIDE WHAT THE RENT WAS.
--
-- `amount` stays the rent alone. Every RentCharge written before today means
-- exactly what it meant then, and a column whose meaning changes under old rows
-- is worse than a new column — a re-read of last year's billing has to give
-- last year's answer.
--
-- What the tenant was invoiced for a period is amount + serviceCharge.
ALTER TABLE "RentCharge" ADD COLUMN "serviceCharge" BIGINT NOT NULL DEFAULT 0;
