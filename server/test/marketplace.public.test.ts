// The public marketplace: no sign-in, only approved listings of organisations with a usable subscription, no
// personal data in any answer, every submission routed to the owning organisation only, abuse limits, and the
// For Business request feeding the core organisation onboarding.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agencyOrg,
  client,
  publishedListing,
  SALE,
  photoBody,
  startAgencyServer,
  STAY,
  type AgencyOrg,
} from "./support/agency-fixture.js";
import { refused, type TestServer } from "./support/test-server.js";

/** Every field the public may see on a listing; anything else is a leak. */
const PUBLIC_KEYS = [
  "amenities",
  "area",
  "bathrooms",
  "bedrooms",
  "city",
  "cleaningFeeMinor",
  "compliance",
  "country",
  "currency",
  "depositMinor",
  "description",
  "id",
  "instantBook",
  "listedBy",
  "maxGuests",
  "media",
  "minNights",
  "number",
  "priceMinor",
  "propertyType",
  "publishedAt",
  "purpose",
  "rating",
  "serviceFeePct",
  "sizeM2",
  "taxPct",
  "title",
];

describe("public marketplace", () => {
  let S: TestServer;
  let A: AgencyOrg;
  let B: AgencyOrg;
  let saleA: string;
  let stayB: string;

  beforeAll(async () => {
    S = await startAgencyServer();
    A = await agencyOrg(S, "Prime Realty");
    B = await agencyOrg(S, "Coast Hosts");
    const owner = await client(A.manager, A.orgId, {
      name: "Seller Private",
      email: "private.seller@example.test",
      phone: "+254700000001",
    });
    saleA = (
      await publishedListing(S, A.orgId, A.manager, { ...SALE, ownerContactId: owner.id, agentUserId: A.agent.userId })
    ).id;
    stayB = (await publishedListing(S, B.orgId, B.manager, STAY)).id;
  });
  afterAll(() => S.close());

  it("shows only approved listings, never drafts, waiting, paused or refused ones", async () => {
    const api = A.manager.api.agency;
    const P = { orgId: A.orgId };
    const draft = await api.createListing({ params: P, body: { ...SALE, title: "Draft flat in Nyali" } });
    const waiting = await api.createListing({ params: P, body: { ...SALE, title: "Waiting flat in Nyali" } });
    await api.uploadPhoto({ params: { ...P, listingId: waiting.id }, body: await photoBody() });
    await api.submitListing({ params: { ...P, listingId: waiting.id } });
    const all = await S.api.marketplace.search({ query: { limit: 50 } });
    expect(all.listings.map((l) => l.id).sort()).toEqual([saleA, stayB].sort());
    await refused(S.api.marketplace.getListing({ params: { listingId: draft.id } }), 404);
    await refused(S.api.marketplace.getListing({ params: { listingId: waiting.id } }), 404);
    // staff refuse the waiting one: still not public
    const staff = await S.staff();
    await staff.api.marketplace.rejectListing({
      params: { listingId: waiting.id },
      body: { reason: "Photo is not of the property" },
    });
    expect((await api.getListing({ params: { ...P, listingId: waiting.id } })).reviewNote).toBe(
      "Photo is not of the property",
    );
    await refused(S.api.marketplace.getListing({ params: { listingId: waiting.id } }), 404);
    // the organisation takes a published listing down, and puts it back through review
    await api.unpublishListing({ params: { ...P, listingId: saleA } });
    await refused(S.api.marketplace.getListing({ params: { listingId: saleA } }), 404);
    await refused(
      api.updateListing({ params: { ...P, listingId: draft.id }, body: { ...SALE, purpose: "rent" } }),
      400,
    );
    await api.submitListing({ params: { ...P, listingId: saleA } });
    await refused(api.updateListing({ params: { ...P, listingId: saleA }, body: SALE }), 409); // waiting: frozen
    await staff.api.marketplace.approveListing({ params: { listingId: saleA }, body: { note: "" } });
    expect((await S.api.marketplace.getListing({ params: { listingId: saleA } })).id).toBe(saleA);
  });

  it("returns no private field and no personal data, anywhere", async () => {
    const r = await S.raw("GET", "/api/v1/public/listings?limit=50");
    expect(r.status).toBe(200);
    for (const l of r.body.listings) expect(Object.keys(l).sort()).toEqual([...PUBLIC_KEYS].sort());
    const one = await S.raw("GET", `/api/v1/public/listings/${saleA}`);
    expect(Object.keys(one.body).sort()).toEqual([...PUBLIC_KEYS, "reviews"].sort());
    const text = JSON.stringify([r.body, one.body]);
    for (const secret of ["Plot 77", "gate code", "private.seller", "+254700000001", A.agent.userId, A.orgId, B.orgId])
      expect(text).not.toContain(secret);
  });

  it("filters: purpose, city, text, type, price, bedrooms, guests, amenities, free dates, sort", async () => {
    const m = S.api.marketplace;
    const ids = async (query: NonNullable<Parameters<typeof m.search>[0]>["query"]) =>
      (await m.search({ query })).listings.map((l) => l.id);
    expect(await ids({ purpose: "stay" })).toEqual([stayB]);
    expect(await ids({ city: "DIANI" })).toEqual([stayB]);
    expect(await ids({ q: "oceanview" })).toEqual([saleA]);
    expect(await ids({ q: "100%_" })).toEqual([]); // wildcards are matched literally
    expect(await ids({ propertyType: "villa" })).toEqual([stayB]);
    expect(await ids({ maxPriceMinor: 5_000_000 })).toEqual([stayB]);
    expect(await ids({ minPriceMinor: 5_000_000 })).toEqual([saleA]);
    expect(await ids({ bedrooms: 4 })).toEqual([stayB]);
    expect(await ids({ purpose: "stay", guests: 9 })).toEqual([]);
    expect(await ids({ amenities: "pool,beach" })).toEqual([stayB]);
    expect(await ids({ sort: "price_high" })).toEqual([saleA, stayB]);
    expect(await ids({ sort: "price_low" })).toEqual([stayB, saleA]);
    // a confirmed stay takes the villa out of searches for those nights only
    await B.manager.api.agency.createStay({
      params: { orgId: B.orgId },
      body: {
        kind: "block",
        listingId: stayB,
        checkIn: "2026-11-01",
        checkOut: "2026-11-05",
        source: "owner",
        note: "Owner's week",
      },
    });
    expect(await ids({ purpose: "stay", checkIn: "2026-11-03", checkOut: "2026-11-06" })).toEqual([]);
    expect(await ids({ purpose: "stay", checkIn: "2026-11-05", checkOut: "2026-11-08" })).toEqual([stayB]);
    await refused(m.search({ query: { checkIn: "2026-11-05" } }), 400);
    const av = await m.availability({ params: { listingId: stayB }, query: { from: "2026-10-31", to: "2026-11-06" } });
    expect(av.days.map((d) => d.available)).toEqual([true, false, false, false, false, true]);
    expect(JSON.stringify(av)).not.toContain("Owner's week");
  });

  it("an enquiry reaches the owning organisation's inbox only", async () => {
    const r = await S.api.marketplace.enquire({
      params: { listingId: stayB },
      body: { name: "Asha Guest", phone: "+254 711 222 333", message: "Is the pool heated?" },
    });
    expect(r.status).toBe("received");
    const inB = await B.agent.api.agency.inbox({ params: { orgId: B.orgId } });
    expect(inB.enquiries.map((e) => e.message)).toContain("Is the pool heated?");
    const inA = await A.manager.api.agency.inbox({ params: { orgId: A.orgId } });
    expect(inA.enquiries.map((e) => e.message)).not.toContain("Is the pool heated?");
    // the contact exists in B only
    expect((await S.sql("SELECT org_id FROM contacts WHERE phone_norm = '711222333'")).map((c) => c.org_id)).toEqual([
      B.orgId,
    ]);
    // another organisation cannot touch B's enquiry or listing
    const enquiryId = inB.enquiries[0]!.id;
    await refused(A.manager.api.agency.convertEnquiry({ params: { orgId: A.orgId, enquiryId }, body: {} }), 404);
    await refused(A.manager.api.agency.getListing({ params: { orgId: A.orgId, listingId: stayB } }), 404);
    // spam is closed without a lead, once
    const closed = await B.agent.api.agency.closeEnquiry({
      params: { orgId: B.orgId, enquiryId },
      body: { status: "spam" },
    });
    expect(closed.status).toBe("spam");
    await refused(
      B.agent.api.agency.closeEnquiry({ params: { orgId: B.orgId, enquiryId }, body: { status: "closed" } }),
      409,
    );
    await refused(B.agent.api.agency.convertEnquiry({ params: { orgId: B.orgId, enquiryId }, body: {} }), 409);
    // one person cannot flood a listing: three open enquiries at most
    for (let i = 0; i < 3; i++)
      await S.api.marketplace.enquire({
        params: { listingId: stayB },
        body: { name: "Asha Guest", phone: "+254711222333", message: `again ${i}` },
      });
    await refused(
      S.api.marketplace.enquire({
        params: { listingId: stayB },
        body: { name: "Asha Guest", phone: "+254711222333", message: "4th" },
      }),
      429,
      "TOO_MANY_ATTEMPTS",
    );
    // a viewing request needs a date, and stays are booked rather than viewed
    await refused(
      S.api.marketplace.enquire({
        params: { listingId: saleA },
        body: { kind: "viewing_request", name: "No Date", email: "nd@example.test" },
      }),
      400,
    );
    await refused(
      S.api.marketplace.enquire({
        params: { listingId: stayB },
        body: { kind: "viewing_request", name: "Viewer", email: "v@example.test", preferredDate: "2026-10-20" },
      }),
      400,
    );
  });

  it("hides listings of an organisation whose subscription is suspended", async () => {
    const staff = await S.staff();
    await staff.api.admin.setSubscriptionStatus({
      params: { orgId: B.orgId },
      body: { status: "suspended", reason: "Unpaid invoice", product: "agency" },
    });
    expect((await S.api.marketplace.search({ query: {} })).listings.map((l) => l.id)).toEqual([saleA]);
    await refused(
      S.api.marketplace.enquire({ params: { listingId: stayB }, body: { name: "X Person", email: "x@example.test" } }),
      404,
    );
    await staff.api.admin.setSubscriptionStatus({
      params: { orgId: B.orgId },
      body: { status: "active", reason: "Paid by bank transfer", product: "agency" },
    });
    expect((await S.api.marketplace.search({ query: {} })).total).toBe(2);
  });

  it("guest tokens: a wrong token looks like an unknown reference", async () => {
    const o = await S.api.marketplace.makeOffer({
      params: { listingId: saleA },
      body: { name: "Buyer One", email: "buyer1@example.test", amountMinor: 1_500_000_000 },
    });
    expect(o.token.length).toBeGreaterThan(20);
    await refused(
      S.api.marketplace.offerStatus({ params: { reference: o.reference }, body: { token: o.token + "x" } }),
      404,
    );
    expect(
      (await S.api.marketplace.offerStatus({ params: { reference: o.reference }, body: { token: o.token } })).status,
    ).toBe("pending");
    await refused(
      S.api.marketplace.makeOffer({
        params: { listingId: saleA },
        body: { name: "Buyer One", email: "buyer1@example.test", amountMinor: 1 },
      }),
      409,
    ); // one open offer per person
    await refused(
      S.api.marketplace.makeOffer({
        params: { listingId: stayB },
        body: { name: "Buyer Two", email: "b2@example.test", amountMinor: 1000 },
      }),
      400,
    ); // offers are for homes for sale
    const w = await S.api.marketplace.withdrawOffer({ params: { reference: o.reference }, body: { token: o.token } });
    expect(w.status).toBe("withdrawn");
    // the stored token is a hash
    expect((await S.sql("SELECT token_hash FROM agency_offers WHERE id = $1", [o.reference]))[0].token_hash).not.toBe(
      o.token,
    );
  });

  it("staff endpoints are invisible to customers and to anonymous callers", async () => {
    await refused(A.admin.api.marketplace.moderationQueue({ query: {} }), 404);
    await refused(S.api.marketplace.moderationQueue({ query: {} }), 401);
    expect((await S.raw("POST", `/api/v1/admin/marketplace/listings/${saleA}/approve`, { note: "" })).status).toBe(401);
  });

  it("For Business: a request waits for PALTAS staff, who create the organisation through the core onboarding", async () => {
    const m = S.api.marketplace;
    const body = {
      product: "agency" as const,
      orgName: "Lakeview Homes Agency",
      registrationNumber: "PVT-2026-0042",
      country: "Kenya",
      currency: "KES",
      timezone: "Africa/Nairobi",
      contactName: "Halima Yusuf",
      contactEmail: "halima@lakeview.test",
      modules: ["crm", "finance"],
      details: { agents: "6" },
      authorityConfirmed: true as const,
    };
    const r = await m.requestBusiness({ body });
    expect(r.status).toBe("pending");
    await refused(m.requestBusiness({ body: { ...body, contactEmail: "other@lakeview.test" } }), 409); // already waiting
    await refused(m.requestBusiness({ body: { ...body, orgName: "Prime Realty" } }), 409); // already a customer
    await refused(
      m.requestBusiness({ body: { ...body, orgName: "Lakeview Two", registrationNumber: "pvt-2026-0042" } }),
      409,
    ); // same registration
    await refused(m.requestBusiness({ body: { ...body, orgName: "Other Name", modules: ["maint"] } }), 400); // not offered
    expect(
      (await S.raw("POST", "/api/v1/public/business-requests", { ...body, authorityConfirmed: false })).status,
    ).toBe(400);
    expect((await S.sql("SELECT count(*)::int AS n FROM organisations WHERE name = $1", [body.orgName]))[0].n).toBe(0);

    const staff = await S.staff();
    // a request can be refused with a reason (it is then not waiting any more)
    const spam = await m.requestBusiness({ body: { ...body, orgName: "Totally Real Agency", registrationNumber: "" } });
    const spamId = (await staff.api.marketplace.businessRequests({ query: {} })).requests.find(
      (x) => x.reference === spam.reference,
    )!.id;
    const refusedReq = await staff.api.marketplace.rejectBusinessRequest({
      params: { requestId: spamId },
      body: { reason: "Could not verify the company" },
    });
    expect(refusedReq).toMatchObject({ status: "rejected", decisionNote: "Could not verify the company", orgId: null });
    const list = await staff.api.marketplace.businessRequests({ query: {} });
    const req = list.requests.find((x) => x.reference === r.reference)!;
    expect(req).toMatchObject({ orgName: body.orgName, modules: ["crm", "finance"], details: { agents: "6" } });
    const done = await staff.api.marketplace.approveBusinessRequest({
      params: { requestId: req.id },
      body: { plan: "AGENCY-STD", trial: true },
    });
    expect(done.request.status).toBe("approved");
    expect(done.temporaryPassword).toBeTruthy();
    const orgId = done.request.orgId!;
    // the core created organisation, subscription, administrator and chart (agency accounts included)
    const [sub] = await S.sql("SELECT product, plan_id, status FROM subscriptions WHERE org_id = $1", [orgId]);
    expect(sub).toEqual({ product: "agency", plan_id: "AGENCY-STD", status: "trial" });
    const [mem] = await S.sql(
      "SELECT m.role, u.email FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.org_id = $1",
      [orgId],
    );
    expect(mem).toEqual({ role: "org_admin", email: "halima@lakeview.test" });
    const codes = (await S.sql("SELECT code FROM ledger_accounts WHERE org_id = $1", [orgId])).map((a) => a.code);
    expect(codes).toEqual(expect.arrayContaining(["1000", "1180", "2470", "4700", "4710"]));
    await refused(
      staff.api.marketplace.approveBusinessRequest({
        params: { requestId: req.id },
        body: { plan: "AGENCY-STD", trial: true },
      }),
      409,
    );
    // the new administrator signs in and works in the new organisation
    const admin = await S.login("halima@lakeview.test", done.temporaryPassword!);
    await admin.api.identity.changePassword({
      body: { currentPassword: done.temporaryPassword!, newPassword: "Lakeview-Strong-2026!" },
    });
    expect((await admin.api.agency.listListings({ params: { orgId }, query: {} })).listings).toEqual([]);
  });

  it("limits how often one address may search and submit", async () => {
    const L = await startAgencyServer({ marketplace: { searchPerMinute: 3, submitPerHour: 2 } });
    try {
      for (let i = 0; i < 3; i++) expect((await L.raw("GET", "/api/v1/public/listings")).status).toBe(200);
      const over = await L.raw("GET", "/api/v1/public/listings");
      expect(over.status).toBe(429);
      expect(over.body.error.code).toBe("TOO_MANY_ATTEMPTS");
      const biz = (n: number) =>
        L.raw("POST", "/api/v1/public/business-requests", {
          product: "property",
          orgName: `Spam Co ${n}`,
          country: "Kenya",
          currency: "KES",
          timezone: "Africa/Nairobi",
          contactName: "Spam Bot",
          contactEmail: `spam${n}@example.test`,
          authorityConfirmed: true,
        });
      expect((await biz(1)).status).toBe(201);
      expect((await biz(2)).status).toBe(201);
      expect((await biz(3)).status).toBe(429);
      expect((await L.sql("SELECT count(*)::int AS n FROM mkt_business_requests"))[0].n).toBe(2);
    } finally {
      await L.close();
    }
  });
});
