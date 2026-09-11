-- ======================================================================
-- PROMOTION TARGETING.
--
-- The pushed frontend's carousel narrows a campaign by market:
--
--     countries        ["KE"]         only these markets
--     excludeCountries ["SE"]         everywhere but these
--     regions          ["africa"]     coarser than a country
--     cities           ["Makkah"]     matched against the DESTINATION
--     currencies       ["KES"]        only where prices are in these
--     languages        ["sw"]         only to readers of these
--     requiresPayment  "mpesa"        only where that rail actually resolves
--     requiresService  "hajj_umrah"   only where that service exists
--     requiresProduct  …              only where that product is sold
--
-- It read all nine off every promotion and this table had none of them, so a
-- customer could not target a market at all — their promotion went everywhere
-- or nowhere. Every one is optional and every one NARROWS: a promotion with
-- none of them stays global, which is the right default because most are.
--
-- NULL, not an empty array. "I did not target this" and "I targeted nothing"
-- are different statements, and an empty array read as a filter matches
-- nothing at all — which would hide the promotion everywhere.
-- ======================================================================

ALTER TABLE "Promotion" ADD COLUMN "countries"        TEXT[];
ALTER TABLE "Promotion" ADD COLUMN "excludeCountries" TEXT[];
ALTER TABLE "Promotion" ADD COLUMN "regions"          TEXT[];
ALTER TABLE "Promotion" ADD COLUMN "cities"           TEXT[];
ALTER TABLE "Promotion" ADD COLUMN "currencies"       TEXT[];
ALTER TABLE "Promotion" ADD COLUMN "languages"        TEXT[];
ALTER TABLE "Promotion" ADD COLUMN "requiresPayment"  TEXT;
ALTER TABLE "Promotion" ADD COLUMN "requiresService"  TEXT;
ALTER TABLE "Promotion" ADD COLUMN "requiresProduct"  TEXT;
