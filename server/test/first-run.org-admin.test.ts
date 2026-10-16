// The person who signs up is the organisation administrator and often the only member of a new trial. In every
// product they must be able to finish the first-run set-up alone: these tests sign up through the public endpoint
// and do each product's first set-up steps with that one account (property's full workflow is in
// property.owner-workflow.test.ts).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { roleCan } from "@paltas/contracts";
import { SALE } from "./support/agency-fixture.js";
import { TAX } from "./support/hotel-fixture.js";
import { SITE_POS } from "./support/security-fixture.js";
import { signUpAndIn, signupServer } from "./support/signup-fixture.js";
import type { TestServer } from "./support/test-server.js";

describe("first-run set-up by the organisation administrator alone", () => {
  let S: TestServer;
  beforeAll(async () => {
    S = await signupServer();
  });
  afterAll(() => S.close());

  it("property: a property, its units and a tenant", async () => {
    const a = await signUpAndIn(S, "property");
    const orgId = a.orgId;
    const p = await a.api.property.createProperty({ params: { orgId }, body: { name: "First Court" } });
    const units = await a.api.property.createUnits({
      params: { orgId, propertyId: p.id },
      body: { units: [{ unitNo: "A1" }, { unitNo: "A2" }] },
    });
    expect(units.units).toHaveLength(2);
    const tenant = await a.api.contacts.createContact({
      params: { orgId },
      body: { name: "First Tenant", types: ["tenant"], email: "first.tenant@business.test" },
    });
    expect(tenant.contact.types).toContain("tenant");
  });

  it("hotel: the hotel, room types, rooms and the first prices (rate plan)", async () => {
    expect(roleCan("org_admin", "hotel.rates.manage")).toBe(true);
    const a = await signUpAndIn(S, "hotel");
    const orgId = a.orgId;
    const h = a.api.hotel;
    const p = await h.createProperty({
      params: { orgId },
      body: { name: "First Hotel", country: "Kenya", city: "Mombasa", timezone: "Africa/Nairobi", tax: TAX },
    });
    const P = { orgId, propertyId: p.id };
    const std = await h.createRoomType({
      params: P,
      body: { code: "STD", name: "Standard", capacityAdults: 2, beds: "1 king" },
    });
    await h.createRooms({ params: P, body: { rooms: [{ number: "101", roomTypeId: std.id, floor: "1" }] } });
    const bar = await h.createRatePlan({
      params: P,
      body: {
        code: "BAR",
        name: "Best available rate",
        kind: "bar",
        policy: { refundable: true, freeCancelDays: 2, cancelFeeNights: 1, noShowFeeNights: 1 },
        baseRates: [{ roomTypeId: std.id, amountMinor: 1_200_000 }],
      },
    });
    expect(bar.code).toBe("BAR");
  });

  it("security: a client, a site with a post, a guard and the first roster", async () => {
    for (const cap of ["security.roster.manage", "security.visitors", "security.control"] as const)
      expect(roleCan("org_admin", cap)).toBe(true);
    const a = await signUpAndIn(S, "security");
    const orgId = a.orgId;
    const s = a.api.security;
    const client = await s.createClient({
      params: { orgId },
      body: { name: "First Client Ltd", contactName: "Daniel Kariuki", paymentTermsDays: 30 },
    });
    const site = await s.createSite({
      params: { orgId },
      body: { clientId: client.id, name: "First Site", kind: "Office", geofence: { ...SITE_POS, radiusM: 200 } },
    });
    const post = await s.createPost({
      params: { orgId, siteId: site.id },
      body: { name: "Gate A", cover: "24h", guardsRequired: 1 },
    });
    const guard = await s.createGuard({
      params: { orgId },
      body: {
        name: "Amina Hassan",
        grade: "Guard",
        licenceNo: "PSRA-90001",
        licenceExpiry: "2030-06-30",
        vetting: "cleared",
        homeSiteId: site.id,
      },
    });
    const day = S.app.clock.today();
    const [shift] = (
      await s.createShifts({
        params: { orgId },
        body: { postId: post.id, shifts: [{ startsAt: `${day}T06:00:00Z`, endsAt: `${day}T18:00:00Z` }] },
      })
    ).shifts;
    const assigned = await s.assignShift({ params: { orgId, shiftId: shift!.id }, body: { guardId: guard.id } });
    expect(assigned.guardId).toBe(guard.id);
  });

  it("development: a project and its first units", async () => {
    const a = await signUpAndIn(S, "developer");
    const orgId = a.orgId;
    const project = await a.api.development.createProject({ params: { orgId }, body: { name: "First Heights" } });
    const units = await a.api.development.createUnits({
      params: { orgId, projectId: project.id },
      body: { units: [{ unitNo: "T1-01", listPriceMinor: 900_000_000 }] },
    });
    expect(units.units).toHaveLength(1);
  });

  it("agency: the first listing", async () => {
    const a = await signUpAndIn(S, "agency");
    const listing = await a.api.agency.createListing({ params: { orgId: a.orgId }, body: SALE });
    expect(listing.id).toBeTruthy();
  });
});
