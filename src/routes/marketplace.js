/* ====================================================================== *
 * THE PUBLIC MARKETPLACE.
 *
 * The homepage had no way to show a real property. Every listing endpoint in
 * this service sits behind a session AND an AGENT_HOST entitlement, which is
 * correct for an agent managing their own book and useless for a visitor who
 * has not signed in. So the homepage showed nine local arrays instead, and a
 * visitor could not tell those from inventory.
 *
 * This is the one public read. It is deliberately narrow.
 *
 * ── WHAT MAKES SOMETHING PUBLIC ─────────────────────────────────────────
 *
 * `status: "LIVE"`, and nothing else. That value is an intentional act: an
 * agent moved a listing out of DRAFT to put it in front of the market. It is
 * the only signal in this schema that anybody consented to publication, so it
 * is the only one this endpoint honours.
 *
 * That is why PROJECTS ARE NOT HERE. A development project has a stage
 * (PLANNING, and so on) and no publish flag at all, so there is no way to tell
 * a project its owner wants advertised from one they are quietly costing.
 * Publishing the second kind would be a disclosure nobody asked for. The
 * "New developments" section therefore shows an empty state until somebody
 * decides what publishing a development means — a product decision, not
 * something to infer from a stage name.
 *
 * Rooms, services, units, parties and every other operational table are
 * absent for the same reason.
 *
 * ── WHAT IS NOT RETURNED, AND WHY ───────────────────────────────────────
 *
 *   ownerName   a named private individual. The company offering the listing
 *               is a business and is returned; the owner behind it is not.
 *   mandate     the commercial terms between agent and owner.
 *   note        an agent's internal remarks.
 *   orgId       no internal identifier needs to reach a browser.
 *
 * ── AND WHAT SIMPLY DOES NOT EXIST ──────────────────────────────────────
 *
 * There is no rating, no review and no image on a Listing anywhere in this
 * schema — `image` belongs to Promotion. So this endpoint returns none of
 * them, and the cards that read it show none. A star rating invented here
 * would be the most quietly corrosive thing on the page: every visitor would
 * believe it came from a guest.
 * ====================================================================== */

import { Router } from "express";
import { db } from "../db.js";
import { badRequest } from "../http/errors.js";
import { rateLimit } from "../http/rate-limit.js";

export const marketplaceRoutes = Router();

const KINDS = new Set(["SHORT_STAY", "LONG_LET", "FOR_SALE"]);

/** Money stays in minor units, as everywhere else in this service. */
const wire = (l) => {
  const unit = l.unit || null;
  const site = (unit && unit.site) || null;
  return {
    id: l.id,
    title: l.title,
    kind: l.kind,
    price: l.price,
    currency: l.currency,
    /* Where it is, as specifically as the record actually knows. */
    city: site ? site.city : "",
    country: site ? site.country : "",
    place: (unit && unit.buildingName) || (site ? site.name : ""),
    /* What sort of home, when a unit is attached. */
    unitKind: unit ? unit.kind : "",
    sqm: unit ? unit.sqm : null,
    floor: unit ? unit.floor : null,
    /* Who is offering it — the company, never the owner. */
    offeredBy: l.org ? l.org.name : "",
    listedAt: l.createdAt,
    /*
     * Amenities that are FACTS about the property rather than internal
     * configuration: whether the company offering it runs an airport transfer
     * service that is switched on. Computed below, never stored here.
     */
    transfer: Boolean(l.__transfer),
    /*
     * Whether that transfer costs anything, and nothing more than that.
     *
     *   true   the service is configured as not chargeable  -> free
     *   false  the service charges                          -> paid
     *   null   no transfer service, so the question does not apply
     *
     * It reads HotelService.chargeable, which is the flag the property itself
     * set inside Hotel Management. It is deliberately nullable rather than
     * defaulting to free, because "we do not know" and "it is free" are
     * different answers and only one of them is true.
     *
     * What is NOT here is direction. A guest wants to know whether they will be
     * collected on arrival, dropped off on departure, or both, and the schema
     * has nowhere to record it — HotelService has a name, a kind and a
     * chargeable flag. So the endpoint does not answer it, and the marketplace
     * does not pretend to filter on it.
     */
    transferFree: l.__transfer ? l.__transferFree : null,
    hotel: Boolean(l.__hotel),
  };
};

/*
 * One public endpoint, generously rate-limited.
 *
 * Keyed on IP, which is the only thing there is — nobody has signed in. The
 * ceiling is high because a homepage legitimately asks for several sections at
 * once and a shared office should not run out.
 */
marketplaceRoutes.get("/marketplace/listings",
  rateLimit({ windowMs: 60_000, max: 240 }),
  async (req, res, next) => {
    try {
      const take = Math.min(48, Math.max(1, Number(req.query.limit) || 12));

      const where = { status: "LIVE" };

      if (req.query.kind) {
        const kind = String(req.query.kind).toUpperCase();
        if (!KINDS.has(kind)) {
          throw badRequest(`kind must be one of: ${[...KINDS].join(", ").toLowerCase()}.`);
        }
        where.kind = kind;
      }

      /* Location filters read through the unit's site, which is where a city
         actually lives. An unmatched city returns nothing, which is the right
         answer rather than everything. */
      const city = String(req.query.city || "").trim();
      const country = String(req.query.country || "").trim().toUpperCase();
      if (city || country) {
        where.unit = {
          site: {
            ...(city ? { city: { equals: city, mode: "insensitive" } } : {}),
            ...(country ? { country: { equals: country, mode: "insensitive" } } : {}),
          },
        };
      }

      /*
       * PUBLIC BY DESIGN — every listing here has status LIVE, which is an
       * agent's own decision to publish it. There is no orgId filter because
       * a marketplace that only showed you your own listings would not be one.
       */
      const rows = await db.listing.findMany({
        where,
        orderBy: [{ createdAt: "desc" }],
        take,
        select: {
          id: true, title: true, kind: true, price: true, currency: true,
          createdAt: true, orgId: true,
          org: { select: { name: true } },
          unit: {
            select: {
              kind: true, sqm: true, floor: true, buildingName: true,
              site: { select: { name: true, city: true, country: true } },
            },
          },
          /* ownerName, mandate and note are deliberately absent — see the note
             at the top of this file. */
        },
      });

      /*
       * Which of these companies can actually collect somebody from an airport,
       * and which run a hotel. Two grouped queries rather than a per-row lookup,
       * and only for the companies already in the result.
       */
      const orgIds = [...new Set(rows.map((r) => r.orgId))];
      const [transfers, hotels] = orgIds.length
        ? await Promise.all([
            db.hotelService.findMany({
              where: { orgId: { in: orgIds }, active: true, kind: { contains: "ransfer" } },
              select: { orgId: true, chargeable: true },
            }),
            db.entitlement.findMany({
              where: { orgId: { in: orgIds }, product: "HOTEL_MANAGEMENT" },
              select: { orgId: true },
            }),
          ])
        : [[], []];

      const hasTransfer = new Set(transfers.map((t) => t.orgId));
      /*
       * A company may run more than one transfer service. If ANY of them is
       * free the company can collect you for nothing, so free wins — the
       * generous reading is the one a guest can rely on, and the opposite would
       * tell somebody they must pay when they need not.
       */
      const freeTransfer = new Set(
        transfers.filter((t) => t.chargeable === false).map((t) => t.orgId));
      const isHotel = new Set(hotels.map((h) => h.orgId));
      for (const r of rows) {
        r.__transfer = hasTransfer.has(r.orgId);
        r.__transferFree = freeTransfer.has(r.orgId);
        r.__hotel = isHotel.has(r.orgId);
      }

      let listings = rows.map(wire);

      /* A filter the homepage's transfer chips use. Applied after the amenity
         is known, because it is computed rather than stored. */
      if (String(req.query.transfer) === "true") {
        listings = listings.filter((l) => l.transfer);
      }
      /* Free and paid, which the chargeable flag can answer honestly. */
      if (String(req.query.transferFree) === "true") {
        listings = listings.filter((l) => l.transferFree === true);
      }
      if (String(req.query.transferFree) === "false") {
        listings = listings.filter((l) => l.transferFree === false);
      }
      if (String(req.query.hotel) === "true") {
        listings = listings.filter((l) => l.hotel);
      }

      /*
       * Public inventory, so it may be cached briefly — a minute is long enough
       * to absorb a homepage's nine requests and short enough that a new
       * listing appears while the agent is still looking at the page.
       */
      res.set("Cache-Control", "public, max-age=60, stale-while-revalidate=300");
      res.json({
        listings,
        count: listings.length,
        /*
         * Said out loud, so a client never has to infer it from an empty array:
         * nothing is being withheld, there is simply nothing published yet.
         */
        source: "live-listings",
      });
    } catch (e) { next(e); }
  });
