// Agent / Host rules: organisation isolation (another organisation's ids answer 404), role refusals enforced by the
// server, separation of duties, the agent's own-leads view, viewing clashes, and which product may do what.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agencyOrg,
  client,
  ledgerBalance,
  publishedListing,
  SALE,
  sha,
  startAgencyServer,
  STAY,
  type AgencyOrg,
} from "./support/agency-fixture.js";
import { refused, type TestServer } from "./support/test-server.js";

describe("agency rules", () => {
  let S: TestServer;
  let A: AgencyOrg;
  let B: AgencyOrg;
  let saleA: string;
  const PA = () => ({ orgId: A.orgId });

  beforeAll(async () => {
    S = await startAgencyServer();
    A = await agencyOrg(S, "Prime Realty");
    B = await agencyOrg(S, "Rival Realty");
    saleA = (await publishedListing(S, A.orgId, A.manager, SALE)).id;
  });
  afterAll(() => S.close());

  it("another organisation's records answer 404, never 403", async () => {
    const b = B.manager.api.agency;
    const lead = await A.manager.api.agency.createLead({
      params: PA(),
      body: { person: { name: "Private Lead", email: "pl@example.test" }, source: "Walk-in", listingId: saleA },
    });
    await refused(b.getListing({ params: { orgId: B.orgId, listingId: saleA } }), 404);
    await refused(b.updateListing({ params: { orgId: B.orgId, listingId: saleA }, body: SALE }), 404);
    await refused(b.getLead({ params: { orgId: B.orgId, leadId: lead.id } }), 404);
    await refused(
      b.bookViewing({ params: { orgId: B.orgId, leadId: lead.id }, body: { date: "2026-10-20", time: "10:00" } }),
      404,
    );
    // using A's organisation id is refused as an unknown organisation
    await refused(b.listLeads({ params: PA(), query: {} }), 404);
    await refused(b.inbox({ params: PA(), query: {} }), 404);
    // B cannot point its own records at A's listing or A's contact
    await refused(
      b.createLead({
        params: { orgId: B.orgId },
        body: { person: { name: "X Y", phone: "+254700111222" }, source: "Web", listingId: saleA },
      }),
      404,
    );
    const contactA = (await A.manager.api.contacts.listContacts({ params: PA(), query: {} })).contacts[0]!;
    await refused(
      b.createAgreement({
        params: { orgId: B.orgId },
        body: { kind: "sale", clientContactId: contactA.id, commissionPct: 2, startsOn: "2026-10-01" },
      }),
      404,
    );
    expect((await b.listLeads({ params: { orgId: B.orgId }, query: {} })).leads).toEqual([]);
  });

  it("concurrent staff approvals publish once and refuse the stale decision", async () => {
    const l = await A.manager.api.agency.createListing({ params: PA(), body: SALE });
    await A.manager.api.agency.addMedia({
      params: { ...PA(), listingId: l.id },
      body: {
        kind: "photo",
        fileName: "review.jpg",
        contentType: "image/jpeg",
        sizeBytes: 100,
        sha256: sha("concurrent-review"),
      },
    });
    await A.manager.api.agency.submitListing({ params: { ...PA(), listingId: l.id } });
    const staff = await S.staff();
    const outcomes = await Promise.allSettled(
      [1, 2].map(() =>
        staff.api.marketplace.approveListing({
          params: { listingId: l.id },
          body: { note: "Reviewed for publication" },
        }),
      ),
    );
    expect(outcomes.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((r) => r.status === "rejected")).toHaveLength(1);
    expect((await A.manager.api.agency.getListing({ params: { ...PA(), listingId: l.id } })).status).toBe("published");
    await staff.api.marketplace.rejectListing({
      params: { listingId: l.id },
      body: { reason: "Concurrency test finished" },
    });
  });

  it("PALTAS staff can take a published listing down, with the reason the organisation sees", async () => {
    const l = await publishedListing(S, A.orgId, A.manager, { ...SALE, title: "Take-down flat in Nyali" });
    expect((await S.api.marketplace.getListing({ params: { listingId: l.id } })).id).toBe(l.id);
    const staff = await S.staff();
    await staff.api.marketplace.rejectListing({
      params: { listingId: l.id },
      body: { reason: "Reported as already sold" },
    });
    await refused(S.api.marketplace.getListing({ params: { listingId: l.id } }), 404);
    const back = await A.manager.api.agency.getListing({ params: { ...PA(), listingId: l.id } });
    expect(back).toMatchObject({ status: "rejected", reviewNote: "Reported as already sold" });
  });

  it("roles: what each person may do is enforced by the server", async () => {
    const draft = { params: PA(), body: { ...SALE, title: "Role test flat in Nyali" } };
    await refused(A.viewer.api.agency.listListings({ params: PA(), query: {} }), 403, "ROLE_NOT_ALLOWED");
    await refused(A.auditor.api.agency.createListing(draft), 403, "ROLE_NOT_ALLOWED");
    await refused(A.accountant.api.agency.createListing(draft), 403, "ROLE_NOT_ALLOWED");
    // a leasing agent drafts listings but cannot submit them to the marketplace
    const l = await A.agent.api.agency.createListing(draft);
    await A.agent.api.agency.addMedia({
      params: { ...PA(), listingId: l.id },
      body: { kind: "photo", fileName: "p.jpg", contentType: "image/jpeg", sizeBytes: 10, sha256: sha("p") },
    });
    await refused(A.agent.api.agency.submitListing({ params: { ...PA(), listingId: l.id } }), 403, "ROLE_NOT_ALLOWED");
    await A.manager.api.agency.submitListing({ params: { ...PA(), listingId: l.id } });
    // only PALTAS staff publish: no customer endpoint and no database path can publish without a reviewer
    await expect(S.sql("UPDATE agency_listings SET status = 'published' WHERE id = $1", [l.id])).rejects.toThrow(
      /agency_listing_published_reviewed/,
    );
    // an auditor reads and reports, but cannot move a lead or close a deal
    expect((await A.auditor.api.agency.summary({ params: PA(), query: {} })).listings.published).toBe(1);
    await refused(A.auditor.api.agency.listLeads({ params: PA(), query: {} }), 403, "ROLE_NOT_ALLOWED");
    await refused(
      A.accountant.api.agency.closeDeal({
        params: PA(),
        body: { listingId: saleA, agreementId: "agr_x", closedOn: "2026-10-11" },
      }),
      403,
      "ROLE_NOT_ALLOWED",
    );
    await refused(A.agent.api.agency.listPayouts({ params: PA() }), 403, "ROLE_NOT_ALLOWED");
    await refused(
      A.manager.api.agency.stayPayment({
        params: { ...PA(), stayId: "sty_x" },
        body: { kind: "payment", amountMinor: 1, method: "cash", reference: "R-1" },
      }),
      403,
      "ROLE_NOT_ALLOWED",
    );
  });

  it("a leasing agent sees their own and unassigned leads; only a manager assigns", async () => {
    const mk = (p: typeof A.agent, name: string) =>
      p.api.agency.createLead({
        params: PA(),
        body: { person: { name, email: `${name.replace(/ /g, ".")}@example.test` }, source: "Phone" },
      });
    const own = await mk(A.agent, "Agent One Lead");
    const other = await mk(A.agent2, "Agent Two Lead");
    const pool = await A.manager.api.agency.createLead({
      params: PA(),
      body: { person: { name: "Unassigned Lead", email: "pool@example.test" }, source: "Web" },
    });
    expect(own.agentUserId).toBe(A.agent.userId);
    expect(pool.agentUserId).toBeNull();
    const seen = (await A.agent.api.agency.listLeads({ params: PA(), query: {} })).leads.map((l) => l.id);
    expect(seen).toContain(own.id);
    expect(seen).toContain(pool.id);
    expect(seen).not.toContain(other.id);
    await refused(A.agent.api.agency.getLead({ params: { ...PA(), leadId: other.id } }), 404);
    await refused(
      A.agent.api.agency.noteLead({ params: { ...PA(), leadId: other.id }, body: { kind: "call", text: "hi" } }),
      404,
    );
    await refused(
      A.agent.api.agency.assignLead({ params: { ...PA(), leadId: pool.id }, body: { agentUserId: A.agent.userId } }),
      403,
      "ROLE_NOT_ALLOWED",
    );
    // the manager sees all and assigns; an accountant cannot be given leads
    expect((await A.manager.api.agency.listLeads({ params: PA(), query: {} })).leads.length).toBeGreaterThanOrEqual(3);
    await refused(
      A.manager.api.agency.assignLead({
        params: { ...PA(), leadId: pool.id },
        body: { agentUserId: A.accountant.userId },
      }),
      400,
    );
    await A.manager.api.agency.assignLead({
      params: { ...PA(), leadId: pool.id },
      body: { agentUserId: A.agent2.userId },
    });
    expect((await A.agent.api.agency.listLeads({ params: PA(), query: {} })).leads.map((l) => l.id)).not.toContain(
      pool.id,
    );
    // a call counts as the first response and moves a new lead to contacted; 'won' comes only from a deal
    const called = await A.agent.api.agency.noteLead({
      params: { ...PA(), leadId: own.id },
      body: { kind: "call", text: "Called back" },
    });
    expect(called.stage).toBe("contacted");
    expect(called.firstResponseAt).not.toBeNull();
    await refused(A.agent.api.agency.moveLead({ params: { ...PA(), leadId: own.id }, body: { stage: "won" } }), 400);
    await refused(A.agent.api.agency.moveLead({ params: { ...PA(), leadId: own.id }, body: { stage: "lost" } }), 400);
    const lost = await A.agent.api.agency.moveLead({
      params: { ...PA(), leadId: own.id },
      body: { stage: "lost", lostReason: "Bought elsewhere" },
    });
    expect(lost.stage).toBe("lost");
    await refused(
      A.agent.api.agency.moveLead({ params: { ...PA(), leadId: own.id }, body: { stage: "qualified" } }),
      409,
    );
  });

  it("an agent is never in two viewings within the hour (also a database rule)", async () => {
    const l1 = await A.agent.api.agency.createLead({
      params: PA(),
      body: { person: { name: "Viewer One", email: "v1@example.test" }, source: "Web", listingId: saleA },
    });
    const l2 = await A.agent.api.agency.createLead({
      params: PA(),
      body: { person: { name: "Viewer Two", email: "v2@example.test" }, source: "Web", listingId: saleA },
    });
    const v1 = await A.agent.api.agency.bookViewing({
      params: { ...PA(), leadId: l1.id },
      body: { date: "2026-10-20", time: "10:00" },
    });
    await refused(
      A.agent.api.agency.bookViewing({
        params: { ...PA(), leadId: l2.id },
        body: { date: "2026-10-20", time: "10:45" },
      }),
      409,
    );
    await A.agent.api.agency.bookViewing({
      params: { ...PA(), leadId: l2.id },
      body: { date: "2026-10-20", time: "11:00" },
    });
    // another agent may view at the same time; an agent cannot book for a colleague
    await refused(
      A.agent.api.agency.bookViewing({
        params: { ...PA(), leadId: l2.id },
        body: { date: "2026-10-21", time: "10:00", agentUserId: A.agent2.userId },
      }),
      403,
    );
    const confirmed = await A.agent.api.agency.viewingAction({
      params: { ...PA(), viewingId: v1.id },
      body: { action: "confirm" },
    });
    expect(confirmed.status).toBe("confirmed");
    // cancelling frees the slot
    await A.agent.api.agency.viewingAction({
      params: { ...PA(), viewingId: v1.id },
      body: { action: "cancel", reason: "Client asked to move" },
    });
    await A.agent.api.agency.bookViewing({
      params: { ...PA(), leadId: l1.id },
      body: { date: "2026-10-20", time: "09:30" },
    });
    await refused(
      A.agent.api.agency.bookViewing({
        params: { ...PA(), leadId: l1.id },
        body: { date: "2026-10-01", time: "10:00" },
      }),
      400,
    );
  });

  it("separation of duties: whoever raised a commission cannot decide it (also a database rule)", async () => {
    const seller = await client(A.manager, A.orgId, { name: "Seller Two", email: "s2@example.test" });
    const agr = await A.manager.api.agency.createAgreement({
      params: PA(),
      body: {
        kind: "sale",
        clientContactId: seller.id,
        commissionPct: 2,
        commissionFixedMinor: 1_000_000,
        vatPct: 16,
        startsOn: "2026-01-01",
      },
    });
    // the manager closes a deal and so raises the commission
    const listing = await publishedListing(S, A.orgId, A.manager, {
      ...SALE,
      title: "Second flat in Nyali",
      priceMinor: 1_000_000_000,
    });
    const { commission } = await A.manager.api.agency.closeDeal({
      params: PA(),
      body: { listingId: listing.id, agreementId: agr.id, closedOn: "2026-10-11" },
    });
    // 2 % of 10,000,000.00 + 10,000.00 fixed = 210,000.00; VAT 33,600.00
    expect(commission).toMatchObject({ commissionMinor: 21_000_000, vatMinor: 3_360_000, totalMinor: 24_360_000 });
    await refused(
      A.manager.api.agency.decideCommission({
        params: { ...PA(), commissionId: commission.id },
        body: { decision: "approve" },
      }),
      403,
      "ROLE_NOT_ALLOWED",
    );
    // whoever raised it may not decide it, whatever their role: record the finance director as the raiser and try
    await S.sql("UPDATE agency_commissions SET raised_by = $2 WHERE id = $1", [commission.id, A.fd.userId]);
    await refused(
      A.fd.api.agency.decideCommission({
        params: { ...PA(), commissionId: commission.id },
        body: { decision: "approve" },
      }),
      403,
      "SEPARATION_OF_DUTIES",
    );
    await expect(
      S.sql("UPDATE agency_commissions SET approved_by = raised_by, status = 'approved' WHERE id = $1", [
        commission.id,
      ]),
    ).rejects.toThrow(/agency_commission_second_person/);
    const rej = await A.accountant.api.agency.decideCommission({
      params: { ...PA(), commissionId: commission.id },
      body: { decision: "reject", reason: "Fee not agreed in writing" },
    });
    expect(rej.status).toBe("rejected");
    expect(await ledgerBalance(S, A.orgId, "4700")).toBe(0); // nothing posted
    await refused(
      A.accountant.api.agency.decideCommission({
        params: { ...PA(), commissionId: commission.id },
        body: { decision: "approve" },
      }),
      409,
    );
    // a listing closes once
    await refused(
      A.manager.api.agency.closeDeal({
        params: PA(),
        body: { listingId: listing.id, agreementId: agr.id, closedOn: "2026-10-11" },
      }),
      409,
    );
  });

  it("products: Property Management lists homes on the marketplace but has no stays, leads or deals", async () => {
    const pmOrg = await S.newOrg({ name: "Almas Lettings", product: "property", plan: "PM-STARTER", trial: false });
    const pm = await S.addMember(pmOrg.orgId, pmOrg.admin.api, "property_manager");
    const P = { orgId: pmOrg.orgId };
    const rent = await pm.api.agency.createListing({
      params: P,
      body: { ...SALE, purpose: "rent", title: "Two-bed flat to let", priceMinor: 8_000_000 },
    });
    expect(rent.status).toBe("draft");
    await refused(pm.api.agency.createListing({ params: P, body: STAY }), 400); // stays are Agent / Host
    await refused(pm.api.agency.listLeads({ params: P, query: {} }), 404); // not part of its subscriptions
    await refused(pm.api.agency.listStays({ params: P, query: {} }), 404);
    expect((await pm.api.agency.inbox({ params: P, query: {} })).enquiries).toEqual([]);
    // an agency stay cannot be dealt; a sale listing cannot be booked
    await refused(
      S.api.marketplace.requestBooking({
        params: { listingId: saleA },
        body: {
          name: "Some Guest",
          email: "sg@example.test",
          checkIn: "2026-11-01",
          checkOut: "2026-11-03",
          guests: 1,
        },
      }),
      400,
    );
  });

  it("people are the ONE contact store: merging two contacts moves their agency records", async () => {
    await S.api.marketplace.enquire({
      params: { listingId: saleA },
      body: { name: "Juma Twice", email: "juma@example.test", message: "First address" },
    });
    await S.api.marketplace.enquire({
      params: { listingId: saleA },
      body: { name: "Juma Twice", phone: "+254 799 000 111", message: "Second channel" },
    });
    const both = (await A.manager.api.contacts.listContacts({ params: PA(), query: { q: "Juma" } })).contacts;
    expect(both).toHaveLength(2); // different e-mail and phone: two records until someone merges them
    const [keep, gone] = both as [(typeof both)[0], (typeof both)[0]];
    const r = await A.manager.api.contacts.mergeContacts({
      params: { ...PA(), contactId: keep.id },
      body: { mergeId: gone.id, reason: "Same person, two channels" },
    });
    expect(r.moved).toBeGreaterThan(0);
    const inbox = (await A.manager.api.agency.inbox({ params: PA(), query: {} })).enquiries.filter((e) =>
      e.contact.name.startsWith("Juma"),
    );
    expect(inbox.map((e) => e.contact.id)).toEqual([keep.id, keep.id]);
  });

  it("media are metadata only: the storage adapter is a labelled test adapter", async () => {
    const l = await A.manager.api.agency.createListing({
      params: PA(),
      body: { ...SALE, title: "Media flat in Nyali" },
    });
    const r = await A.manager.api.agency.addMedia({
      params: { ...PA(), listingId: l.id },
      body: {
        kind: "document",
        fileName: "title-deed.pdf",
        contentType: "application/pdf",
        sizeBytes: 90_000,
        sha256: sha("deed"),
      },
    });
    expect(r.upload).toEqual({
      adapter: "test-storage",
      connected: false,
      status: "Not connected — test adapter",
      uploadUrl: null,
    });
    await refused(
      A.manager.api.agency.addMedia({
        params: { ...PA(), listingId: l.id },
        body: { kind: "photo", fileName: "dup.pdf", contentType: "application/pdf", sizeBytes: 1, sha256: sha("deed") },
      }),
      409,
    ); // the same file twice
    await A.manager.api.agency.removeMedia({ params: { ...PA(), listingId: l.id, mediaId: r.media.id } });
    expect((await A.manager.api.agency.getListing({ params: { ...PA(), listingId: l.id } })).media).toEqual([]);
    // writes need an active subscription; records stay readable
    const staff = await S.staff();
    await staff.api.admin.setSubscriptionStatus({
      params: PA(),
      body: { status: "suspended", reason: "Unpaid invoice", product: "agency" },
    });
    await refused(A.manager.api.agency.createListing({ params: PA(), body: SALE }), 402, "SUBSCRIPTION_INACTIVE");
    expect((await A.manager.api.agency.listListings({ params: PA(), query: {} })).listings.length).toBeGreaterThan(0);
    await staff.api.admin.setSubscriptionStatus({
      params: PA(),
      body: { status: "active", reason: "Paid by bank transfer", product: "agency" },
    });
  });
});
