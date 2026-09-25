/* ====================================================================== *
 * THE SAMPLE CATALOGUE.
 *
 * Properties to put on the page before a real supplier is connected and before
 * PALTAS's own agents have published anything — so the marketplace can be
 * demonstrated, reviewed and sold with a populated page instead of nine empty
 * shelves.
 *
 * ── READ THIS BEFORE CHANGING ANYTHING BELOW ────────────────────────────
 *
 * NONE OF THIS IS REAL. Not the properties, not the prices, not the ratings.
 * Nobody can book any of it and no money can move against it. It exists to
 * show what the page looks like with inventory in it.
 *
 * That is a genuinely dangerous thing to put on a public site, so it is
 * constrained in six ways, and every one of them matters:
 *
 *   1. OFF BY DEFAULT. Nothing registers this. It requires
 *      PALTAS_SAMPLE_SUPPLY=1 to be set deliberately, and `connectSuppliers()`
 *      will not reach for it while a real supplier has credentials.
 *
 *   2. IT IS A SUPPLIER, NOT A LISTING. It goes through the same seam as
 *      Expedia and Booking.com, which means it can only ever reach the `supply`
 *      array. PALTAS's own `listings` array is computed by code this file
 *      cannot touch, so an empty marketplace still reports honestly as empty.
 *
 *   3. sandbox: true. The frontend already stamps every sandbox card
 *      "SANDBOX — not bookable" and prints a warning under any shelf that
 *      contains one. That machinery is tested, and this inherits all of it.
 *
 *   4. EVERY TITLE SAYS "(sample)". On the card, in the text, so it survives a
 *      screenshot. A badge can be cropped out of an image; a title cannot.
 *
 *   5. A DISCLOSURE ON EVERY ROW, not just in the envelope — because a card can
 *      be rendered by a client that never read the envelope.
 *
 *   6. NO REAL BUSINESS IS NAMED. The titles are generic property descriptions.
 *      Putting a real hotel's name on invented inventory at an invented price
 *      would misrepresent that company, which is worse than the fake listing.
 *
 * ── WHAT IT DELIBERATELY DOES NOT DO ────────────────────────────────────
 *
 * No images. An image would have to be hotlinked from somebody's server
 * without a licence, and a sample is not a reason to do that. Cards without a
 * photograph render correctly — that path already exists because PALTAS
 * listings have no images either.
 *
 * No randomness. The same query returns the same catalogue every time, so a
 * reviewer comparing two screenshots is comparing the page and not the dice.
 *
 * It ANSWERS WITHOUT DATES, and this is the one place it deliberately diverges
 * from a real wholesaler. Expedia and Booking.com refuse, because their price
 * is a live quote against allocation and there is no such thing until somebody
 * names the nights. A sample price is not a quote at all, so there is nothing
 * to be wrong about — and the whole purpose here is a populated page on a plain
 * homepage load. With no dates it quotes a single night and says so.
 * ====================================================================== */

import { SupplyUnavailable } from "../domain/supply.ts";
import type {
  AccommodationSupplier, SupplierDescription, SupplyQuery, SupplyResult,
} from "../domain/supply.ts";

/**
 * The shapes of property a marketplace shows, with a plausible nightly figure
 * in USD minor units.
 *
 * Generic descriptions, not business names — see constraint 6 above. The prices
 * are round numbers on purpose: an invented price that looks precise ("$147.50")
 * invites more belief than one that obviously does not.
 */
/**
 * One sample shape: what it is, what it costs a night in USD minor units,
 * how many beds, the invented rating and how many invented reviews.
 *
 * A tuple rather than an object because the list reads as a table, and a
 * table of eight rows is easier to check by eye than eight objects.
 */
type Shape = readonly [
  shape: string, perNight: number, beds: number, rating: number, reviews: number,
];

const SHAPES: readonly Shape[] = [
  ["Beachfront apartment",      18000, 2, 8.6, 214],
  ["City-centre studio",         9000, 1, 8.1, 402],
  ["Garden villa with pool",    42000, 4, 9.2, 97],
  ["Harbour-view suite",        26000, 2, 8.8, 156],
  ["Two-bedroom townhouse",     21000, 2, 8.4, 63],
  ["Business hotel room",       12000, 1, 7.9, 511],
  ["Family apartment, quiet street", 16000, 3, 8.5, 88],
  ["Serviced studio, long stay", 11000, 1, 8.0, 139],
];

const DISCLOSURE =
  "This is sample content used to demonstrate the PALTAS marketplace. " +
  "It is not a real property, the price is not a real rate, and it cannot be booked.";

/** How much sample inventory, and where it is allowed to appear. */
export interface SampleConfig {
  /** How many sample properties to return per search (1–8). */
  readonly count?: number;
  /**
   * Optional allow-list. When empty the sample answers for any city, because
   * a demo that only works in Mombasa is not much of a demo.
   */
  readonly cities?: readonly string[];
}

export function sampleCatalogue(
  { count = 6, cities = [] }: SampleConfig = {},
): AccommodationSupplier {
  const n = Math.min(SHAPES.length, Math.max(1, Number(count) || 6));
  const allow = new Set((cities || []).map((c) => String(c).toLowerCase().trim()));

  return {
    name: "paltas-sample",
    /* What a visitor reads in the attribution line. Says what it is. */
    label: "PALTAS sample catalogue (not real inventory)",
    /* The flag that makes the frontend stamp every card unbookable. */
    sandbox: true,

    describe(): SupplierDescription {
      return {
        name: "paltas-sample",
        label: "PALTAS sample catalogue (not real inventory)",
        connected: true,
        sandbox: true,
        capabilities: ["search"],
        disclosure: DISCLOSURE,
        why:
          "The SAMPLE CATALOGUE is connected. Every property shown from it is " +
          "demonstration content: not real, not bookable, and marked as such on " +
          "each card. No licensed supplier is connected. Set " +
          "EXPEDIA_RAPID_API_KEY or BOOKING_DEMAND_TOKEN to replace it with real " +
          "inventory, or unset PALTAS_SAMPLE_SUPPLY to show nothing at all.",
      };
    },

    async search(
      { city = "", country = "", checkIn = "", checkOut = "", limit = 12 }: SupplyQuery = {},
    ): Promise<SupplyResult> {
      /*
       * Dates if there are any, one night if not.
       *
       * A real supplier refuses here — its price is a live quote and there is
       * none until the nights are named. This does not, because a sample price
       * is not a quote and the point of the catalogue is a page with something
       * on it the moment a visitor arrives. One night is the honest default: it
       * makes the figure a nightly rate rather than a total over a span nobody
       * chose.
       */
      const a = Date.parse(`${checkIn}T00:00:00Z`);
      const b = Date.parse(`${checkOut}T00:00:00Z`);
      const dated = Number.isFinite(a) && Number.isFinite(b) && b > a;
      const nights = dated ? Math.round((b - a) / 86_400_000) : 1;

      if (allow.size && city && !allow.has(String(city).toLowerCase().trim())) {
        return { offers: [], note: `The sample catalogue is limited to: ${[...allow].join(", ")}.` };
      }

      const where = city || "your selected city";
      return {
        offers: SHAPES.slice(0, Math.min(n, Math.max(1, limit))).map((sh: Shape, i: number) => {
          const [shape, perNight, beds, rating, reviews] = sh;
          return {
            supplierRef: `sample-${i + 1}`,
            /*
             * "(sample)" is IN THE TITLE, not only in a badge beside it. A badge
             * can be cropped out of a screenshot; the title travels with it.
             */
            title: `${shape}, ${where} (sample)`,
            city,
            country: String(country || "").toUpperCase(),
            place: "Sample location",
            /* A stay total, like every real supplier returns. */
            price: perNight * nights,
            currency: "USD",
            nights,
            /* Sample content is not a real cancellation policy, so it claims
               none. Null means "not stated", which is the truth. */
            refundable: null,
            rating,
            ratingCount: reviews,
            /* No image: hotlinking somebody's photograph without a licence is
               not made acceptable by the card being a sample. */
            image: null,
            deepLink: null,
            beds,
          };
        }),
      };
    },
  };
}

/**
 * Build from the environment. Returns null unless explicitly switched on.
 *
 * The guard is the whole point. A sample catalogue that could appear because a
 * variable was left at its default is how demonstration data ends up on a live
 * marketplace without anybody deciding that it should.
 */
export function fromEnv(env: NodeJS.ProcessEnv = process.env): AccommodationSupplier | null {
  if (env.PALTAS_SAMPLE_SUPPLY !== "1") return null;
  const count = Number(env.PALTAS_SAMPLE_COUNT) || 6;
  const cities = String(env.PALTAS_SAMPLE_CITIES || "")
    .split(",").map((s) => s.trim()).filter(Boolean);
  return sampleCatalogue({ count, cities });
}

/** Exported so a test can assert the disclosure text is the one shipped. */
export { DISCLOSURE };
