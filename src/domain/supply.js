/* ====================================================================== *
 * THE ACCOMMODATION SUPPLY ADAPTER.
 *
 * PALTAS has its own inventory: listings an agent, host or hotel published on
 * this platform. That inventory is the product, and nothing in this file
 * touches it.
 *
 * This is the seam for SOMEBODY ELSE'S inventory — a licensed accommodation
 * wholesaler like Expedia Rapid or the Booking.com Demand API:
 *
 *     PALTAS  ->  this adapter  ->  licensed supplier  ->  hotel
 *
 * ── THE ONE RULE ────────────────────────────────────────────────────────
 *
 * A supplier's room is never a PALTAS listing, and a PALTAS listing is never
 * a supplier's room. They travel in separate arrays, they carry a `source`
 * each, and the card a visitor sees says which it is. Merging them into one
 * undifferentiated list would make PALTAS look larger and make every
 * guarantee it gives — who you are dealing with, who holds the property —
 * untrue for most of the page.
 *
 * ── WHY NOTHING IS STORED ───────────────────────────────────────────────
 *
 * There is no Prisma model here and no cache of supplier content, on purpose,
 * for two independent reasons and either would be enough.
 *
 *   Legally. Both Expedia's and Booking.com's partner terms restrict storing
 *   and redistributing their property content and rates. A table of somebody
 *   else's hotel prices is the kind of thing that ends an API agreement.
 *
 *   Factually. A wholesaler's price is a quote against live allocation with a
 *   lifetime measured in seconds. A price this service saved an hour ago and
 *   showed as current is a number a guest would try to book and could not.
 *
 * So every read is a pass-through, and when the supplier cannot be reached
 * PALTAS shows its own listings and says the supplier is unavailable. It does
 * not serve the last thing it saw.
 *
 * ── WHAT THIS FILE REFUSES TO DO ────────────────────────────────────────
 *
 * No supplier is connected to this installation — connecting one needs a
 * signed commercial agreement and credentials, which are not a thing code can
 * produce. So `notConnected` below returns NO offers. It does not return a
 * plausible hotel in the right city at a believable nightly rate.
 *
 * That matters more here than almost anywhere else in this service. A fake
 * supplier result is a room a person will try to book, on a date, for a price,
 * with a card. It is indistinguishable from a working integration right up to
 * the moment money moves, and then it is somebody's holiday.
 * ====================================================================== */

/** Thrown when a supplier was asked to do something it cannot. */
export class SupplyUnavailable extends Error {
  constructor(message) {
    super(message);
    this.name = "SupplyUnavailable";
    /* 503, not 500: nothing is broken, a capability is absent. */
    this.status = 503;
    this.expose = true;
  }
}

/**
 * THE INTERFACE A SUPPLIER MUST IMPLEMENT.
 *
 * Documented as a shape rather than enforced as a class, for the same reason
 * the tokenisation adapter does it this way: the implementation is somebody
 * else's protocol wrapped thinly, and a base class it must extend is a
 * constraint with no benefit.
 *
 *   name        string, e.g. "expedia-rapid". The machine identifier: it keys
 *               every offer and appears in the envelope. Never a display name
 *               pretending to be PALTAS.
 *   label       what a VISITOR reads in the attribution line, e.g.
 *               "Expedia". Optional; falls back to `name`. It exists because
 *               "Supplied by expedia-rapid" is an internal string leaking onto
 *               a public page, and because a supplier's licence usually
 *               specifies the brand name to attribute.
 *   sandbox     boolean. True for a test environment, and then every offer it
 *               returns must be marked so a person cannot mistake one.
 *   describe()  -> { name, connected, sandbox, capabilities[], why }
 *                  Never throws. A settings screen asking "is a supplier
 *                  connected" must get an answer, and "no" is an answer.
 *   search(q)   -> { offers: Offer[], partial?: boolean, note?: string }
 *                  async. May throw SupplyUnavailable.
 *
 * The query it is given:
 *
 *   { city, country, checkIn, checkOut, guests, limit, currency, travellerIp }
 *
 * `travellerIp` is there because both major suppliers require the end
 * traveller's IP on a search — it is how they apply the right market and meet
 * their own compliance obligations. It is passed through, never stored.
 *
 * AN OFFER, NORMALISED. Every field is something the supplier actually said:
 *
 *   supplierRef   the supplier's own property id. The only identifier that can
 *                 be used to book, so it is carried verbatim.
 *   title         property name as the supplier gives it
 *   city, country, place
 *   price         MINOR UNITS, integer, like every other amount in this
 *                 service. A supplier quoting 149.50 becomes 14950.
 *   currency      ISO 4217, as quoted. Never converted here.
 *   nights        how many nights that price covers, because a wholesaler
 *                 quotes a STAY TOTAL and a PALTAS short-let quotes a night.
 *                 A card that prints one as the other is off by a week.
 *   refundable    true / false / null. Null when the supplier did not say.
 *   rating        number or null. A supplier's guest rating IS real data that
 *                 a guest left, unlike anything on a PALTAS listing, so it is
 *                 carried when given — attributed to the supplier, never
 *                 presented as a PALTAS rating.
 *   ratingCount   how many reviews that average is over, or null.
 *   image         a URL the supplier serves, or null. Never re-hosted.
 *   deepLink      where the booking actually happens, when the supplier's
 *                 model requires it.
 */

/* ---------------------------------------------------------------- *
 * THE SUPPLIER IN USE WHEN THERE IS NONE.
 * ---------------------------------------------------------------- */
export const notConnected = {
  name: "",
  sandbox: false,

  describe() {
    return {
      name: "",
      label: "",
      connected: false,
      sandbox: false,
      capabilities: [],
      why: "No accommodation supplier is connected to this installation. " +
           "PALTAS shows the listings its own agents, hosts and hotels have " +
           "published. Connecting a supplier requires a signed agreement and " +
           "credentials from that supplier.",
    };
  },

  /*
   * No offers, and NOT an error.
   *
   * "What does the supplier have in Mombasa?" has a correct answer when no
   * supplier is connected, and it is "nothing this service can see". The
   * marketplace must render its own listings and carry on — a missing
   * wholesaler is not a broken homepage.
   */
  async search() {
    return { offers: [], note: "No accommodation supplier is connected." };
  },
};

/* ---------------------------------------------------------------- *
 * THE REGISTRY.
 *
 * One process, one supplier, chosen by configuration. `register()` exists so a
 * real supplier can be attached without this file knowing anything about it,
 * and so a test can attach a fake that is obviously a fake.
 *
 * Deliberately ONE rather than a list. Two wholesalers offering the same hotel
 * at two prices is a rate-parity problem and a duplicate-inventory problem,
 * and neither should be solved accidentally by a registry that happens to
 * allow an array.
 * ---------------------------------------------------------------- */

let current = notConnected;

export function register(supplier) {
  if (!supplier || typeof supplier.search !== "function") {
    throw new Error("An accommodation supplier must implement search().");
  }
  if (!supplier.name) {
    throw new Error(
      "An accommodation supplier must have a name. Every offer it returns is " +
      "attributed to it, and an unnamed supplier cannot be attributed.");
  }
  current = supplier;
  return current;
}

export const supplier = () => current;
export const isConnected = () => current !== notConnected && Boolean(current.name);

/** Reset to nothing. For tests, and for disabling a supplier deliberately. */
export function clear() {
  current = notConnected;
}

/**
 * What a settings screen and the marketplace envelope read.
 *
 * Never throws, and never returns a credential. The only things here are
 * whether a supplier is connected, which one, whether it is a sandbox, and
 * what it can do — all of which are safe for a browser to see. An API key is
 * not in the shape at all, so it cannot leak through this function.
 */
export function status() {
  try {
    const d = current.describe ? current.describe() : {};
    const name = d.name || current.name || "";
    return {
      connected: isConnected(),
      name,
      /* What the page prints. Falls back to the machine name rather than being
         blank, because an attribution line with nothing in it is worse than an
         ugly one. */
      label: d.label || current.label || name,
      sandbox: Boolean(d.sandbox ?? current.sandbox),
      capabilities: d.capabilities || [],
      why: d.why || "",
      /* A supplier may say, in its own words, what a visitor must be told about
         its inventory. A sample catalogue uses this to say it is not real. */
      disclosure: d.disclosure || "",
    };
  } catch (e) {
    return {
      connected: false, name: "", label: "", sandbox: false, capabilities: [],
      disclosure: "",
      why: "The configured accommodation supplier could not describe itself: " +
           String(e && e.message).slice(0, 160),
    };
  }
}

/* ---------------------------------------------------------------- *
 * NORMALISATION.
 *
 * Every supplier speaks its own dialect. This is where a dialect becomes the
 * one shape the marketplace renders — and where anything the supplier did not
 * actually say becomes null rather than a default.
 * ---------------------------------------------------------------- */

/**
 * A price in major units to the integer minor units this service uses.
 *
 * Returns null rather than 0 for anything unparseable. A missing price shown
 * as "0" reads as free, which is the worst possible way to be wrong about a
 * hotel room.
 */
export function toMinor(amount) {
  const n = typeof amount === "string" ? Number(amount) : amount;
  if (typeof n !== "number" || !Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 100);
}

/**
 * Put a supplier's offer into the shape the marketplace renders, and mark it.
 *
 * `source` is set here, from the supplier's own name, rather than trusted from
 * the offer — so an adapter cannot return `source: "paltas"` by accident or
 * otherwise, and supplier inventory cannot end up wearing PALTAS's name.
 */
export function normaliseOffer(offer, { name, sandbox, label, disclosure }) {
  const nights = Number.isInteger(offer.nights) && offer.nights > 0 ? offer.nights : null;
  const price = Number.isInteger(offer.price) ? offer.price : toMinor(offer.price);

  return {
    /* Namespaced, so a supplier id can never collide with a PALTAS listing id
       in a client that keys on it. */
    id: `${name}:${offer.supplierRef}`,
    supplierRef: String(offer.supplierRef || ""),

    title: String(offer.title || "").trim(),
    city: String(offer.city || "").trim(),
    country: String(offer.country || "").trim(),
    place: String(offer.place || "").trim(),

    price,
    currency: String(offer.currency || "").toUpperCase() || null,
    nights,
    /*
     * A wholesaler quotes a stay total. PALTAS quotes a night. Both are
     * returned and the units are named, because a card that prints a
     * seven-night total under "per night" is wrong by a factor of seven and
     * looks like a bargain.
     */
    priceBasis: nights ? "stay" : "unknown",
    perNight: price !== null && nights ? Math.round(price / nights) : null,
    refundable: typeof offer.refundable === "boolean" ? offer.refundable : null,

    /* Real guest data when the supplier has it, attributed to the supplier. */
    rating: typeof offer.rating === "number" ? offer.rating : null,
    ratingCount: Number.isInteger(offer.ratingCount) ? offer.ratingCount : null,
    image: offer.image ? String(offer.image) : null,
    deepLink: offer.deepLink ? String(offer.deepLink) : null,

    /* Provenance, written here and not by the adapter. */
    source: name,
    supplier: {
      name,
      label: label || name,
      sandbox: Boolean(sandbox),
      /*
       * Carried on EVERY offer, not just in the envelope.
       *
       * A card can be screenshotted, shared, or rendered by a client that never
       * looked at the envelope. If a supplier's inventory must be described as
       * not real, that sentence has to travel with the row rather than sit
       * somewhere a client may not read.
       */
      disclosure: disclosure || "",
    },
    /* Never a PALTAS listing. Said in the row itself so a client cannot get it
       wrong by looking at the wrong field. */
    paltasOwned: false,
  };
}

/**
 * Ask the connected supplier, and never let it break the page.
 *
 * Returns `{ offers, supplier, failed, why, dropped }`. A supplier that throws,
 * times out, or returns nonsense produces an empty list and a reason — it does
 * not propagate, because PALTAS's own listings are the thing the visitor came
 * for and they are unaffected by a wholesaler being down.
 *
 * `why` is always the single explanation that applies, chosen here rather than
 * assembled by each caller: the failure, or the supplier's own note, or why no
 * supplier is connected — and empty when there are offers and nothing to
 * explain.
 */
export async function searchSupply(query = {}) {
  const s = current;
  const name = s.name || "";
  const sandbox = Boolean(s.sandbox);
  const st0 = status();
  const label = st0.label || name;
  const disclosure = st0.disclosure || "";

  if (!isConnected()) {
    const st = status();
    return { offers: [], supplier: st, failed: false, why: st.why, dropped: 0 };
  }

  try {
    const result = await s.search(query);
    const raw = (result && Array.isArray(result.offers)) ? result.offers : [];

    const offers = raw
      /* An offer with no id or no price cannot be shown or booked. Dropped
         rather than rendered with a blank where the price goes. */
      .filter((o) => o && o.supplierRef)
      .map((o) => normaliseOffer(o, { name, sandbox, label, disclosure }))
      .filter((o) => o.price !== null && o.currency);

    return {
      offers,
      supplier: status(),
      failed: false,
      /*
       * ONE explanation, already chosen.
       *
       * A caller needs to answer "why is this list empty" and there are three
       * different reasons. Returning three fields and letting each caller pick
       * guarantees that one of them picks wrong — so the choice is made here,
       * once, and `why` is always the one that applies.
       */
      why: offers.length ? "" : ((result && result.note) || ""),
      /* Said out loud when the adapter dropped some of what it received, so a
         short list is never silently mistaken for a thin market. */
      dropped: raw.length - offers.length,
    };
  } catch (e) {
    return {
      offers: [],
      supplier: status(),
      failed: true,
      /*
       * The supplier's message, truncated, and nothing else. No stack, no
       * request, no headers — a supplier error can carry the echoed request
       * and that is where a key would be.
       */
      why: String((e && e.message) || "The supplier could not be reached.").slice(0, 200),
    };
  }
}
