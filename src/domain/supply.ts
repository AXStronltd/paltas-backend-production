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

import { ExposableFailure } from "../http/errors.ts";
import { messageOf } from "../http/errors.ts";

/**
 * Thrown when a supplier was asked to do something it cannot.
 *
 * 503, not 500: nothing is broken, a capability is absent — which is also why
 * it is exposable. The message names a missing integration, never a key.
 */
export class SupplyUnavailable extends ExposableFailure {
  constructor(message: string) {
    super("SupplyUnavailable", 503, message);
  }
}

/**
 * WHAT A SUPPLIER SAYS ABOUT ITSELF.
 *
 * The prose above this is the contract; this is the same contract in types.
 * Every field is optional but `connected`, because an adapter that cannot
 * answer a question must be able to stay silent rather than invent a value —
 * and status() already falls back for each one.
 */
export interface SupplierDescription {
  readonly connected: boolean;
  readonly name?: string;
  readonly label?: string;
  readonly publicLabel?: string;
  readonly publicName?: string;
  readonly sandbox?: boolean;
  readonly capabilities?: readonly string[];
  readonly why?: string;
  readonly disclosure?: string;
  readonly canTakePayment?: boolean;
  readonly paymentEnvironment?: string;
  /*
   * A SUPPLIER MAY SAY MORE ABOUT ITSELF THAN THIS LIST NAMES.
   *
   * Booking.com reports how many city ids it has mapped; another adapter will
   * want to report something else. Extra keys are safe because status() below
   * is a WHITELIST — it copies the fields named above and nothing else, so
   * anything additional reaches an operator's log and never a response.
   */
  readonly [key: string]: unknown;
}

/** What a supplier is asked. `travellerIp` is passed through, never stored. */
export interface SupplyQuery {
  readonly city?: string;
  readonly country?: string;
  readonly checkIn?: string;
  readonly checkOut?: string;
  readonly guests?: number;
  readonly limit?: number;
  readonly currency?: string;
  readonly travellerIp?: string;
  readonly [key: string]: unknown;
}

/**
 * ONE OFFER AS THE SUPPLIER GIVES IT, before normalisation.
 *
 * Everything here is somebody else's data, so everything is optional and
 * loosely typed — normaliseOffer() below is exactly the place each field is
 * checked, and it is the only place that trusts one.
 */
export interface RawOffer {
  readonly supplierRef?: string | number;
  readonly title?: unknown;
  readonly city?: unknown;
  readonly country?: unknown;
  readonly place?: unknown;
  readonly price?: number | string | null;
  readonly currency?: unknown;
  readonly nights?: number;
  readonly refundable?: unknown;
  readonly rating?: unknown;
  readonly ratingCount?: unknown;
  readonly image?: unknown;
  readonly deepLink?: unknown;
  readonly offerId?: unknown;
  readonly roomName?: unknown;
  readonly boardName?: unknown;
  readonly stars?: unknown;
}

/** What a supplier answers a search with. */
export interface SupplyResult {
  readonly offers?: readonly RawOffer[];
  readonly partial?: boolean;
  readonly note?: string;
}

/**
 * A hotel as the accommodation supplier describes it.
 *
 * Only what a comparison and a room list read. It is somebody else's shape,
 * so every field is optional and the code that reads one already treats them
 * that way.
 */
export interface SupplierHotel {
  /*
   * `| null` throughout, not just `?`.
   *
   * These are two different statements and the adapters make both: a field
   * that is ABSENT was not asked for, and one that is NULL was asked for and
   * the supplier did not say. LiteAPI returns the second — `name: null` for a
   * hotel it holds no name for — and flattening the two would lose which.
   */
  readonly name?: string | null;
  readonly city?: string | null;
  readonly country?: string | null;
  readonly [key: string]: unknown;
}

/**
 * WHAT A SUPPLIER THAT SELLS ROOMS ANSWERS WITH.
 *
 * The fields routes/stays.ts actually reads, and no more. Every one is
 * optional but the identifier each step hangs on, because these come from
 * somebody else's API and a field they stopped sending must degrade rather
 * than throw.
 */
export interface RoomsResult {
  readonly hotelId: string;
  readonly nights: number;
  readonly offers: readonly unknown[];
}

/** A held rate: what it costs now, and how the guest will pay for it. */
export interface PrebookResult {
  readonly prebookId: string;
  readonly offerId?: string | null;
  readonly hotelId?: string | null;
  readonly checkIn?: string | null;
  readonly checkOut?: string | null;
  readonly price?: number | null;
  readonly currency?: string | null;
  /** Anything other than 0 means the price moved between show and hold. */
  readonly priceDifferencePercent?: number | null;
  readonly sandbox?: boolean;
  /** Present only when the guest pays through the supplier's own form. */
  readonly payment?: {
    readonly clientSecret?: string | null;
    readonly transactionId?: string | null;
    readonly publishableKey?: string | null;
    readonly stripeJsUrl?: string | null;
    readonly environment?: string | null;
  } | null;
}

/** A booking, as the supplier reports it back. */
export interface BookingResult {
  readonly bookingId: string;
  readonly clientReference?: string | null;
  readonly status?: string | null;
  /** What the guest shows at the desk. */
  readonly hotelConfirmationCode?: string | null;
  readonly hotelId?: string | null;
  readonly hotelName?: string | null;
  readonly checkIn?: string | null;
  readonly checkOut?: string | null;
  readonly price?: number | null;
  readonly currency?: string | null;
  /** Null means the supplier did not say — not the same as non-refundable. */
  readonly refundable?: boolean | null;
  readonly cancellation?: readonly unknown[];
  readonly createdAt?: string | null;
  readonly supplierBookingId?: string | null;
  readonly sandbox?: boolean;
}

/** What a room list is asked for. */
export interface RoomsQuery {
  readonly hotelId?: string;
  readonly checkIn?: string;
  readonly checkOut?: string;
  readonly guests?: number;
  readonly currency?: string;
}

/** Which hotel, and in which country — /data/hotels demands both. */
export interface HotelQuery {
  readonly hotelId?: string;
  readonly countryCode?: string;
}

/** Which offer to hold, and whether the guest pays through the supplier. */
export interface PrebookQuery {
  readonly offerId?: string;
  readonly usePaymentSdk?: boolean;
}

/** Who the booking is in the name of. All three names are required. */
export interface BookingHolder {
  readonly firstName?: string;
  readonly lastName?: string;
  readonly email?: string;
  readonly phone?: string;
}

/** One guest on the booking. Falls back to the holder where a field is blank. */
export interface BookingGuest {
  readonly occupancyNumber?: number;
  readonly firstName?: string;
  readonly lastName?: string;
  readonly email?: string;
  readonly phone?: string;
  readonly remarks?: string;
}

/**
 * What taking a held rate needs.
 *
 * `transactionId` is what separates a booking the guest paid for from one
 * PALTAS would be charged for — a supplier that has no payment step refuses
 * without it.
 */
export interface BookRequest {
  readonly prebookId?: string;
  readonly holder?: BookingHolder;
  readonly guests?: readonly BookingGuest[];
  readonly clientReference?: string;
  readonly transactionId?: string;
}

/** Which booking to read back or cancel. */
export interface BookingQuery {
  readonly bookingId?: string;
}

/** What cancelling cost. A non-refundable booking still cancels. */
export interface CancelResult {
  readonly bookingId: string;
  readonly status?: string | null;
  /** Charged anyway, and said so. */
  readonly charged?: boolean;
  readonly cancellationFee?: number | null;
  readonly refund?: number | null;
  readonly currency?: string | null;
  readonly sandbox?: boolean;
}

/**
 * THE INTERFACE A SUPPLIER MUST IMPLEMENT, as a type.
 *
 * `search` and `name` are the two an adapter cannot omit — register() below
 * refuses one that does, at runtime, for adapters that arrive from
 * configuration and were never type-checked against this.
 */
export interface AccommodationSupplier {
  readonly name: string;
  readonly label?: string;
  readonly publicLabel?: string;
  readonly publicName?: string;
  readonly sandbox?: boolean;
  describe?(): SupplierDescription;
  search(query: SupplyQuery): Promise<SupplyResult>;

  /*
   * ── AND THE SIX A SUPPLIER THAT CAN ACTUALLY SELL A ROOM HAS ─────────
   *
   * OPTIONAL, because searching and selling are different capabilities and
   * most adapters have only the first. Expedia Rapid and Booking.com Demand
   * return prices; LiteAPI holds a rate, takes a booking, reads it back and
   * cancels it.
   *
   * Every route in routes/stays.ts already checks `typeof s.book !== "function"`
   * before reaching for one and refuses with a sentence when it is absent —
   * which is the behaviour these declarations describe rather than change. A
   * caller cannot reach one without the check, because the type says it may
   * not be there.
   */

  /** Every bookable offer at one hotel, cheapest first. */
  rooms?(query: RoomsQuery): Promise<RoomsResult>;
  /** One hotel's name, city and classification — never a price. */
  hotel?(query: HotelQuery): Promise<SupplierHotel | null>;
  /** Hold an offer and get the real, final price. */
  prebook?(query: PrebookQuery): Promise<PrebookResult>;
  /** Take the held rate. */
  book?(query: BookRequest): Promise<BookingResult>;
  /** What the supplier currently says about a booking. */
  booking?(query: BookingQuery): Promise<BookingResult>;
  /** Cancel, and report honestly what it cost. */
  cancel?(query: BookingQuery): Promise<CancelResult>;
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
 *   label       what an OPERATOR reads. e.g. "Expedia". Optional; falls back
 *               to `name`. It exists because "Supplied by expedia-rapid" is an
 *               internal string, and because a supplier's licence usually
 *               specifies the brand name to attribute.
 *   publicLabel what a VISITOR reads in the attribution line, when that is
 *               not the same thing. Optional; falls back to `label`.
 *
 *               The two differ for a WHOLESALER. Booking.com and Expedia are
 *               consumer brands whose licences require their name on the
 *               inventory, so for them the labels are the same string. An
 *               aggregator PALTAS buys through is a commercial relationship
 *               and not a brand a guest has any use for — naming it tells the
 *               guest who to book with instead of PALTAS.
 *
 *               What it must NOT do is stop disclosing that the room is not a
 *               PALTAS listing. That disclosure is about who the guest's
 *               contract is with, which is a different question from which
 *               company PALTAS buys through, and it stays either way.
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
export const notConnected: AccommodationSupplier = {
  name: "",
  sandbox: false,

  describe(): SupplierDescription {
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

let current: AccommodationSupplier = notConnected;

export function register(supplier: AccommodationSupplier): AccommodationSupplier {
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

export const supplier = (): AccommodationSupplier => current;
export const isConnected = (): boolean => current !== notConnected && Boolean(current.name);

/** Reset to nothing. For tests, and for disabling a supplier deliberately. */
export function clear(): void {
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
    const d: Partial<SupplierDescription> = current.describe ? current.describe() : {};
    const name = d.name || current.name || "";
    return {
      connected: isConnected(),
      name,
      /* What the page prints. Falls back to the machine name rather than being
         blank, because an attribution line with nothing in it is worse than an
         ugly one. */
      label: d.label || current.label || name,
      /* Falls back to the operator label: a supplier that does not draw the
         distinction is one whose brand a visitor is meant to read. */
      publicLabel: d.publicLabel || current.publicLabel || d.label || current.label || name,
      /* Absent for every supplier whose own name is the one to show. */
      publicName: d.publicName || current.publicName || "",
      sandbox: Boolean(d.sandbox ?? current.sandbox),
      capabilities: d.capabilities || [],
      why: d.why || "",
      /* A supplier may say, in its own words, what a visitor must be told about
         its inventory. A sample catalogue uses this to say it is not real. */
      disclosure: d.disclosure || "",

      /*
       * CAN A GUEST ACTUALLY PAY? — the question this envelope could not answer.
       *
       * The LiteAPI adapter has computed this all along and the whitelist above
       * dropped it, so the only way to learn that a booking cannot be completed
       * was to sign in, choose a room, hold a rate and reach a payment step that
       * says "the payment could not be set up". Everything up to that point
       * looks like a working marketplace.
       *
       * The difference between BOOKABLE and BROWSABLE is the difference between
       * a checkout and a dead end, and it belongs where an operator can read it
       * without spending somebody's afternoon finding out.
       *
       * It is a boolean and a word. No key, no fragment of one, and nothing
       * from which one could be derived — the adapter reports only whether a
       * publishable key is present for the environment it is running in.
       */
      canTakePayment: Boolean(d.canTakePayment),
      paymentEnvironment: d.paymentEnvironment || "",
      /* Said in words too, because a false boolean explains nothing. */
      paymentWhy: d.canTakePayment
        ? ""
        : (d.paymentEnvironment === "sandbox"
            ? "LITEAPI_STRIPE_PK_TEST is not set, so a sandbox booking cannot reach a payment step."
            : "LITEAPI_STRIPE_PK_LIVE is not set, so a booking cannot be paid for. " +
              "Rooms are browsable and holdable; checkout will refuse."),
    };
  } catch (e) {
    return {
      connected: false, name: "", label: "", publicLabel: "", publicName: "",
      sandbox: false, capabilities: [],
      disclosure: "", canTakePayment: false, paymentEnvironment: "",
      paymentWhy: "The supplier could not describe itself, so whether it can " +
                  "take a payment is unknown.",
      why: "The configured accommodation supplier could not describe itself: " +
           messageOf(e).slice(0, 160),
    };
  }
}

/**
 * THE SAME SUPPLIER, AS A VISITOR MAY SEE IT.
 *
 * status() is written for an operator: it names the adapter, says which
 * environment it is in and which environment variable is missing. All of that
 * is correct and none of it belongs in a public response.
 *
 * Two different things were being answered by one object:
 *
 *   an operator asks   "which supplier is connected, and why can it not take
 *                       a payment?"
 *   a visitor asks     "whose room is this, and can I book it?"
 *
 * The visitor's answer is this. It carries no adapter name, no environment
 * variable, no sentence naming the company PALTAS buys through — and it still
 * carries the disclosure that the room is not a PALTAS listing, because that
 * is about who the guest's contract is with rather than who supplies it.
 *
 * `name` is deliberately a neutral token and NOT the adapter's. The adapter
 * name is a database key: bookings are stored under supplier_prebookId, and
 * changing what status().name returns would orphan every existing booking.
 * So the internal identity is left exactly alone and this is a separate view
 * over it.
 */
export function publicStatus() {
  const d = status();
  return {
    connected: d.connected,
    /*
     * The adapter's own name unless it asked to be anonymous.
     *
     * It was briefly a constant for every supplier, which broke two things
     * that had nothing to do with wholesalers: Booking.com and Expedia stopped
     * being identifiable, and the frontend detects the sample catalogue by
     * this exact field to mark it unbookable — so sample inventory would have
     * rendered as if it were real. Only a supplier that sets publicName is
     * anonymised, and only LiteAPI does.
     */
    name: d.publicName || d.name,
    label: d.publicLabel || d.label,
    sandbox: d.sandbox,
    disclosure: d.disclosure,
    canTakePayment: d.canTakePayment,
    /*
     * Whether checkout will work, without saying which key is missing. A
     * visitor cannot act on the name of an environment variable, and it tells
     * anyone reading the response how the integration is put together.
     */
    bookable: Boolean(d.connected && d.canTakePayment),
    /*
     * The same three states status() distinguishes, said in words a guest can
     * act on. "No accommodation supplier is connected" is true and useless to
     * them; it stays on the operator envelope, which is where it can be acted
     * on.
     */
    why: !d.connected ? "Hotel rooms are not available right now."
       : !d.canTakePayment ? "These rooms can be browsed but not booked at the moment."
       : "",
  };
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
export function toMinor(amount: number | string | null | undefined): number | null {
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
/** The provenance stamped onto every row, chosen here and not by the adapter. */
export interface OfferProvenance {
  readonly name: string;
  readonly sandbox?: boolean;
  readonly label?: string;
  readonly disclosure?: string;
}

export function normaliseOffer(
  offer: RawOffer,
  { name, sandbox, label, disclosure }: OfferProvenance,
) {
  const nights: number | null =
    typeof offer.nights === "number" && Number.isInteger(offer.nights) && offer.nights > 0
      ? offer.nights : null;
  const price: number | null =
    typeof offer.price === "number" && Number.isInteger(offer.price)
      ? offer.price : toMinor(offer.price ?? null);

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

    /*
     * THE IDENTIFIER THAT MAKES A PRICE ACTIONABLE.
     *
     * This shape is a whitelist — an adapter cannot smuggle arbitrary fields
     * onto a public row — and `offerId` was being dropped by it, which meant
     * every card showed a price nothing could be done with. A price a guest
     * cannot act on is worse than no price: it is an invitation to a dead end.
     *
     * Null for a supplier whose model has no bookable offer id, and a caller
     * must treat null as "not bookable here" rather than as an error.
     */
    offerId: offer.offerId ? String(offer.offerId) : null,
    /* What the cheapest offer actually is, for a card that wants to say. */
    roomName: offer.roomName ? String(offer.roomName) : "",
    boardName: offer.boardName ? String(offer.boardName) : "",
    /* The property's own star rating, which is not a guest score. */
    stars: Number.isFinite(Number(offer.stars)) ? Number(offer.stars) : null,

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
export async function searchSupply(query: SupplyQuery = {}) {
  const s = current;
  const sandbox = Boolean(s.sandbox);
  const st0 = status();
  const disclosure = st0.disclosure || "";

  /*
   * THE IDENTITY STAMPED ON EVERY ROW IS THE PUBLIC ONE.
   *
   * These offers go straight into a public response, and every row carries
   * its own provenance so a client that never read the envelope still gets
   * it right. That makes the per-row stamp a public surface, which means it
   * must not be the adapter's internal name — it is the visitor's view, not
   * the operator's.
   *
   * The adapter's real name stays available through status() for the places
   * that genuinely need it: the log line at boot, and the supplier key that
   * bookings are stored under.
   */
  const pub = publicStatus();
  const name = pub.name || "";
  const label = pub.label || name;

  if (!isConnected()) {
    return { offers: [], supplier: pub, failed: false, why: st0.why, dropped: 0 };
  }

  try {
    const result = await s.search(query);
    const raw = (result && Array.isArray(result.offers)) ? result.offers : [];

    const offers = raw
      /* An offer with no id or no price cannot be shown or booked. Dropped
         rather than rendered with a blank where the price goes. */
      .filter((o: RawOffer) => o && o.supplierRef)
      .map((o: RawOffer) => normaliseOffer(o, { name, sandbox, label, disclosure }))
      .filter((o) => o.price !== null && o.currency);

    return {
      offers,
      supplier: pub,
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
      supplier: pub,
      failed: true,
      /*
       * The supplier's message, truncated, and nothing else. No stack, no
       * request, no headers — a supplier error can carry the echoed request
       * and that is where a key would be.
       */
      why: (messageOf(e) || "The supplier could not be reached.").slice(0, 200),
    };
  }
}
