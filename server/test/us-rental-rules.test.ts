// United States rental rules (contracts/src/rental-rules.ts), New York City first:
// - Local Law 18 short-term rentals (stays under 30 nights): OSE registration number, host present, at most two guests,
//   no instant booking; PALTAS staff confirm the registration before publishing; bookings only for checked listings.
// - FARE Act rentals: no broker fee charged to the tenant, every tenant fee disclosed on the public listing.
// - Stays of 30 nights or more and listings outside New York City are not affected.
import { rentalRules } from "@paltas/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agencyOrg, photoBody, startAgencyServer, STAY, SALE, type AgencyOrg } from "./support/agency-fixture.js";
import { refused, type TestServer } from "./support/test-server.js";

const NYC_STAY = {
  ...STAY,
  title: "Sunny room in a Brooklyn brownstone",
  description: "A private bedroom in the host's own brownstone, shared kitchen, five minutes from the subway.",
  country: "United States",
  city: "Brooklyn, NY",
  area: "Park Slope",
  bedrooms: 1,
  bathrooms: 1,
  maxGuests: 2,
  minNights: 2,
  instantBook: false,
};
const NYC_RENT = {
  ...SALE,
  purpose: "rent" as const,
  title: "Two-bedroom apartment in Astoria",
  description: "Bright two-bedroom apartment with a renovated kitchen, close to the N/W trains.",
  country: "USA",
  city: "Queens",
  area: "Astoria",
  priceMinor: 320_000,
};
const guest = (n: number) => ({ name: `Guest ${n}`, email: `guest${n}@example.test` });

describe("rental rules (pure)", () => {
  const base: rentalRules.RentalRulesInput = {
    purpose: "stay",
    country: "United States",
    city: "Manhattan",
    minNights: 3,
    maxGuests: 2,
    instantBook: false,
    strRegistrationNumber: "OSE-STRREG-0001234",
    hostPresent: true,
    tenantFees: [],
    noTenantBrokerFee: false,
  };
  it("recognises the five boroughs and the United States", () => {
    for (const city of ["New York", "New York City", "NYC", "Brooklyn, NY", "The Bronx", "Staten Island", "queens"])
      expect(rentalRules.jurisdictionOf("USA", city)).toBe("us-nyc");
    expect(rentalRules.jurisdictionOf("United States of America", "Buffalo")).toBe("us");
    expect(rentalRules.jurisdictionOf("Kenya", "New York")).toBeNull();
  });
  it("a complete New York City short-term rental passes; each missing condition is named", () => {
    expect(rentalRules.rentalRuleIssues(base)).toEqual([]);
    const all = rentalRules.rentalRuleIssues({
      ...base,
      strRegistrationNumber: "",
      hostPresent: false,
      maxGuests: 4,
      instantBook: true,
    });
    expect(all).toHaveLength(4);
    expect(all.join(" ")).toMatch(/registration number.*present.*2 guests.*Instant booking/s);
    expect(rentalRules.rentalRuleIssues({ ...base, strRegistrationNumber: "12345" })[0]).toMatch(/OSE-STRREG-0000123/);
  });
  it("30 nights or more is not a short-term rental; other cities are not affected", () => {
    const bare = { ...base, strRegistrationNumber: "", hostPresent: false, maxGuests: 6, instantBook: true };
    expect(rentalRules.rentalRuleIssues({ ...bare, minNights: 30 })).toEqual([]);
    expect(rentalRules.rentalRuleIssues({ ...bare, city: "Los Angeles" })).toEqual([]);
    expect(rentalRules.rentalRuleIssues({ ...bare, country: "United Kingdom", city: "London" })).toEqual([]);
  });
  it("FARE Act: no tenant broker fee, and no broker or agent fee among the tenant's fees", () => {
    const rent = { ...base, purpose: "rent" as const, minNights: 1 };
    expect(rentalRules.rentalRuleIssues(rent)[0]).toMatch(/FARE Act/);
    expect(rentalRules.rentalRuleIssues({ ...rent, noTenantBrokerFee: true })).toEqual([]);
    expect(
      rentalRules.rentalRuleIssues({
        ...rent,
        noTenantBrokerFee: true,
        tenantFees: [
          { name: "Application fee", amountMinor: 2000, when: "once" },
          { name: "Broker fee", amountMinor: 300_000, when: "once" },
        ],
      }),
    ).toEqual(["Remove broker or agent fees from the tenant's fees (Broker fee)."]);
  });
});

describe("rental rules on the server", () => {
  let S: TestServer;
  let A: AgencyOrg;
  beforeAll(async () => {
    S = await startAgencyServer();
    A = await agencyOrg(S, "Brooklyn Hosts");
  });
  afterAll(() => S.close());
  const P = () => ({ orgId: A.orgId });

  async function draft(body: object) {
    const api = A.manager.api.agency;
    const l = await api.createListing({ params: P(), body: body as never });
    await api.uploadPhoto({ params: { ...P(), listingId: l.id }, body: await photoBody() });
    return l;
  }

  it("a New York City stay under 30 nights cannot be submitted until it meets Local Law 18", async () => {
    const api = A.manager.api.agency;
    const l = await draft({ ...NYC_STAY, maxGuests: 4, instantBook: true });
    expect(l.compliance.jurisdiction).toBe("us-nyc");
    expect(l.compliance.issues).toHaveLength(4);
    const e = await refused(api.submitListing({ params: { ...P(), listingId: l.id } }), 400);
    expect(e.message).toMatch(/registration number/);
    const fixed = await api.updateListing({
      params: { ...P(), listingId: l.id },
      body: { ...NYC_STAY, strRegistrationNumber: "ose-strreg-0004321", hostPresent: true },
    });
    expect(fixed.strRegistrationNumber).toBe("OSE-STRREG-0004321");
    expect(fixed.compliance.issues).toEqual([]);
    await api.submitListing({ params: { ...P(), listingId: l.id } });
  });

  it("staff must confirm the OSE registration check; the public listing shows the number; bookings follow", async () => {
    const api = A.manager.api.agency;
    const staff = await S.staff();
    const queue = await staff.api.marketplace.moderationQueue({ query: { status: "pending_review" } });
    const item = queue.listings.find((x) => x.title === NYC_STAY.title)!;
    expect(item.compliance).toMatchObject({
      jurisdiction: "us-nyc",
      strRegistrationNumber: "OSE-STRREG-0004321",
      hostPresent: true,
      needsRegistrationCheck: true,
      strVerifiedAt: null,
      issues: [],
    });
    const e = await refused(
      staff.api.marketplace.approveListing({ params: { listingId: item.id }, body: { note: "Looks good" } }),
      400,
    );
    expect(e.message).toMatch(/Office of Special Enforcement/);
    const ok = await staff.api.marketplace.approveListing({
      params: { listingId: item.id },
      body: { note: "", registrationChecked: true },
    });
    expect(ok.status).toBe("published");
    expect(ok.compliance.strVerifiedAt).not.toBeNull();

    const pub = await S.api.marketplace.getListing({ params: { listingId: item.id } });
    expect(pub.compliance).toEqual({
      jurisdiction: "us-nyc",
      strRegistrationNumber: "OSE-STRREG-0004321",
      tenantFees: null,
      noTenantBrokerFee: null,
    });
    const b = await S.api.marketplace.requestBooking({
      params: { listingId: item.id },
      body: { ...guest(1), checkIn: "2026-12-01", checkOut: "2026-12-04", guests: 2 },
    });
    expect(b.status).toBe("requested");

    // changing the registration number takes the check away: it must be checked again
    await api.unpublishListing({ params: { ...P(), listingId: item.id } });
    const changed = await api.updateListing({
      params: { ...P(), listingId: item.id },
      body: { ...NYC_STAY, strRegistrationNumber: "OSE-STRREG-0009999", hostPresent: true },
    });
    expect(changed.compliance.strVerifiedAt).toBeNull();
  });

  it("a New York City stay of 30 nights or more needs no registration", async () => {
    const l = await draft({
      ...NYC_STAY,
      title: "Furnished studio in Harlem for a month",
      minNights: 30,
      maxGuests: 3,
    });
    expect(l.compliance.issues).toEqual([]);
    await A.manager.api.agency.submitListing({ params: { ...P(), listingId: l.id } });
    const staff = await S.staff();
    const ok = await staff.api.marketplace.approveListing({ params: { listingId: l.id }, body: { note: "" } });
    expect(ok.compliance.needsRegistrationCheck).toBe(false);
    expect(
      (await S.api.marketplace.getListing({ params: { listingId: l.id } })).compliance.strRegistrationNumber,
    ).toBeNull();
  });

  it("FARE Act: a New York City rental discloses every tenant fee and confirms no tenant broker fee", async () => {
    const api = A.manager.api.agency;
    const l = await draft({
      ...NYC_RENT,
      tenantFees: [{ name: "Broker fee", amountMinor: 380_000, when: "once" }],
    });
    expect(l.compliance.issues).toHaveLength(2);
    await refused(api.submitListing({ params: { ...P(), listingId: l.id } }), 400);
    const fees = [
      { name: "Application and background check", amountMinor: 2_000, when: "once" as const },
      { name: "Amenity fee", amountMinor: 5_000, when: "monthly" as const },
    ];
    await api.updateListing({
      params: { ...P(), listingId: l.id },
      body: { ...NYC_RENT, tenantFees: fees, noTenantBrokerFee: true },
    });
    await api.submitListing({ params: { ...P(), listingId: l.id } });
    const staff = await S.staff();
    await staff.api.marketplace.approveListing({ params: { listingId: l.id }, body: { note: "" } });
    const pub = await S.api.marketplace.getListing({ params: { listingId: l.id } });
    expect(pub.compliance).toEqual({
      jurisdiction: "us-nyc",
      strRegistrationNumber: null,
      tenantFees: fees,
      noTenantBrokerFee: true,
    });
  });
});
