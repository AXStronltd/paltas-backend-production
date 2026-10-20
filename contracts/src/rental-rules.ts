/*
 * Local rental rules PALTAS applies to listings before they reach the marketplace. One source for the server (create,
 * submit, staff approval, booking) and for every screen (the issues are returned with each listing).
 *
 * New York City (the five boroughs):
 * - Short-term rentals: stays of fewer than 30 nights (Local Law 18 of 2022; NYC Admin. Code §26-3101 ff.;
 *   NY Multiple Dwelling Law). The host must hold a short-term rental registration from the Mayor's Office of Special
 *   Enforcement (OSE) and show its number, live in the home and be present during the stay, and take at most two
 *   guests. Booking services must verify each booking's registration with OSE before it proceeds. Stays of 30 nights
 *   or more are not short-term rentals.
 * - Long-term rentals: the FARE Act (Local Law 119 of 2024, in force 11 June 2025). A landlord's broker fee may not be
 *   passed to the tenant, and every listing must clearly disclose all fees a tenant pays to rent the home.
 *
 * This is product logic, not legal advice; the rules are reviewed with counsel and updated when the law changes.
 */
export const NYC_STR_MAX_NIGHTS_EXCLUSIVE = 30;
export const NYC_STR_MAX_GUESTS = 2;
/** OSE registration numbers look like OSE-STRREG-0000123. */
export const NYC_STR_REGISTRATION = /^OSE-STRREG-\d{5,10}$/;

export type Jurisdiction = "us-nyc" | "us" | null;

const US = new Set(["us", "usa", "u.s.", "u.s.a.", "united states", "united states of america"]);
const NYC = new Set([
  "new york",
  "new york city",
  "nyc",
  "ny",
  "manhattan",
  "brooklyn",
  "queens",
  "bronx",
  "the bronx",
  "staten island",
]);
const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");
/** "Brooklyn, NY" and "New York, New York" name the city without the state. */
const cityName = (s: string) =>
  norm(s)
    .replace(/,\s*(ny|new york|new york state|usa|us)$/, "")
    .trim();

export function jurisdictionOf(country: string, city: string): Jurisdiction {
  if (!US.has(norm(country))) return null;
  return NYC.has(cityName(city)) ? "us-nyc" : "us";
}

export interface RentalRulesInput {
  purpose: "sale" | "rent" | "stay";
  country: string;
  city: string;
  minNights: number;
  maxGuests?: number | null | undefined;
  instantBook: boolean;
  strRegistrationNumber: string;
  hostPresent: boolean;
  tenantFees: { name: string; amountMinor: number; when: string }[];
  noTenantBrokerFee: boolean;
}

/** A New York City short-term rental: a stay of fewer than 30 nights in the five boroughs. */
export const isNycShortTermRental = (l: Pick<RentalRulesInput, "purpose" | "country" | "city" | "minNights">) =>
  l.purpose === "stay" && jurisdictionOf(l.country, l.city) === "us-nyc" && l.minNights < NYC_STR_MAX_NIGHTS_EXCLUSIVE;

const BROKER_FEE = /\b(broker|brokerage|finder'?s?|agent'?s?|agency|commission|placement)\b/i;

/** Everything that stops this listing from being submitted or published, in plain words. Empty when it may go. */
export function rentalRuleIssues(l: RentalRulesInput): string[] {
  const out: string[] = [];
  const where = jurisdictionOf(l.country, l.city);
  if (where === "us-nyc" && isNycShortTermRental(l)) {
    if (!l.strRegistrationNumber)
      out.push(
        "New York City stays under 30 nights need the host's short-term rental registration number from the Mayor's Office of Special Enforcement (OSE). Add it, or set the minimum stay to 30 nights or more.",
      );
    else if (!NYC_STR_REGISTRATION.test(l.strRegistrationNumber))
      out.push("Enter the OSE registration number exactly as issued, for example OSE-STRREG-0000123.");
    if (!l.hostPresent)
      out.push(
        "In New York City the host must live in the home and be present during a stay under 30 nights. Confirm this, or set the minimum stay to 30 nights or more.",
      );
    if ((l.maxGuests ?? 0) > NYC_STR_MAX_GUESTS)
      out.push(`New York City stays under 30 nights are limited to ${NYC_STR_MAX_GUESTS} guests at a time.`);
    if (l.instantBook)
      out.push(
        "Instant booking is off for New York City stays under 30 nights: each request is confirmed by the host.",
      );
  }
  if (where === "us-nyc" && l.purpose === "rent") {
    if (!l.noTenantBrokerFee)
      out.push(
        "Under New York City's FARE Act the landlord's broker fee cannot be charged to the tenant. Confirm the tenant pays no broker fee.",
      );
    const bad = l.tenantFees.filter((f) => BROKER_FEE.test(f.name));
    if (bad.length)
      out.push(`Remove broker or agent fees from the tenant's fees (${bad.map((f) => f.name).join(", ")}).`);
  }
  return out;
}
