// Agent / Host end to end: a listing is drafted, published by PALTAS staff, found by an anonymous visitor, enquired
// about, worked as a lead (viewing, offer, counter-offer), closed as a deal, and its commission — approved by a
// second person — is exactly what the ledger holds, through to the money received.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agencyOrg,
  client,
  ledgerBalance,
  publishedListing,
  SALE,
  startAgencyServer,
  type AgencyOrg,
} from "./support/agency-fixture.js";
import { refused, type TestServer } from "./support/test-server.js";

describe("agency acceptance: listing → enquiry → lead → offer → deal → commission → ledger", () => {
  let S: TestServer;
  let A: AgencyOrg;
  const P = () => ({ orgId: A.orgId });

  beforeAll(async () => {
    S = await startAgencyServer();
    A = await agencyOrg(S, "Prime Realty");
  });
  afterAll(() => S.close());

  it("runs the whole agency workflow and the commission equals the ledger", async () => {
    const mgr = A.manager.api.agency;
    // the seller and the commission agreement (3 % + VAT 16 %, the agent keeps 25 % of the commission)
    const seller = await client(A.manager, A.orgId, { name: "Golden Park Ltd", email: "sales@goldenpark.test" });
    const agr = await mgr.createAgreement({
      params: P(),
      body: {
        kind: "sale",
        clientContactId: seller.id,
        commissionPct: 3,
        vatPct: 16,
        agentSharePct: 25,
        startsOn: "2026-10-01",
      },
    });
    expect(agr.number).toBe("AGR-00001");

    // a draft is invisible to the public; staff publish it
    const draft = await mgr.createListing({
      params: P(),
      body: { ...SALE, ownerContactId: seller.id, agreementId: agr.id, agentUserId: A.agent.userId },
    });
    expect(draft.status).toBe("draft");
    expect((await S.api.marketplace.search({ query: { city: "Mombasa" } })).total).toBe(0);
    await refused(mgr.submitListing({ params: { ...P(), listingId: draft.id } }), 400, "INVALID_REQUEST"); // no photo yet
    const l = await publishedListing(S, A.orgId, A.manager, {
      ...SALE,
      ownerContactId: seller.id,
      agreementId: agr.id,
      agentUserId: A.agent.userId,
    });
    expect(l.status).toBe("published");

    // an anonymous visitor finds it
    const found = await S.api.marketplace.search({ query: { purpose: "sale", city: "mombasa", amenities: "pool" } });
    expect(found.listings.map((x) => x.id)).toEqual([l.id]);
    expect(found.listings[0]!.listedBy).toBe("Prime Realty");
    expect(found.listings[0]!.media).toHaveLength(1);
    expect(found.listings[0]!.media[0]!.url).toMatch(/\/media\/.*\/content$/); // real persisted photo

    // two people open the listing (views are counted, nothing about them is kept)
    for (let i = 0; i < 2; i++) await S.api.marketplace.getListing({ params: { listingId: l.id } });

    // enquiry and viewing request go to Prime Realty's inbox
    const enq = await S.api.marketplace.enquire({
      params: { listingId: l.id },
      body: {
        kind: "viewing_request",
        name: "Mary Wanjiru",
        email: "mary@example.test",
        message: "Can I view it on Saturday?",
        preferredDate: "2026-10-17",
        preferredTime: "14:00",
      },
    });
    expect(enq).toEqual({ reference: "ENQ-00001", status: "received" });
    const inbox = await A.agent.api.agency.inbox({ params: P() });
    expect(inbox.enquiries).toHaveLength(1);
    expect(inbox.enquiries[0]).toMatchObject({
      kind: "viewing_request",
      status: "new",
      contact: { name: "Mary Wanjiru" },
    });

    // the enquirer is in the organisation's ONE contact store, with the enquiry on their timeline
    const people = await A.manager.api.contacts.listContacts({ params: P(), query: { q: "Wanjiru" } });
    expect(people.contacts).toHaveLength(1);
    expect(people.contacts[0]).toMatchObject({ types: ["prospect"], tags: ["enquirer"] });
    const mary = people.contacts[0]!.id;
    const timeline = await A.manager.api.contacts.getContact({ params: { ...P(), contactId: mary } });
    expect(timeline.activities.map((x) => x.kind)).toContain("enquiry");

    // the agent converts it: a lead (theirs) and the viewing booked from the requested date
    const conv = await A.agent.api.agency.convertEnquiry({
      params: { ...P(), enquiryId: inbox.enquiries[0]!.id },
      body: {},
    });
    expect(conv.lead).toMatchObject({ stage: "viewing", agentUserId: A.agent.userId, listingId: l.id });
    expect(conv.viewing).toMatchObject({ date: "2026-10-17", time: "14:00", status: "scheduled" });
    const leadId = conv.lead.id;
    await refused(
      A.agent.api.agency.convertEnquiry({ params: { ...P(), enquiryId: inbox.enquiries[0]!.id }, body: {} }),
      409,
    );
    // the viewing outcome can only be recorded on or after the day
    const vid = conv.viewing!.id;
    await refused(
      A.agent.api.agency.viewingAction({
        params: { ...P(), viewingId: vid },
        body: { action: "outcome", attended: true, interest: 4 },
      }),
      400,
    );
    S.setToday("2026-10-17");
    const done = await A.agent.api.agency.viewingAction({
      params: { ...P(), viewingId: vid },
      body: { action: "outcome", attended: true, feedback: "Loved the view", interest: 5 },
    });
    expect(done.status).toBe("completed");
    expect((await A.agent.api.agency.getLead({ params: { ...P(), leadId } })).lead.stage).toBe("viewed");

    // the buyer makes an offer (anonymously, with a private token); the manager counters; the buyer accepts
    const offer = await S.api.marketplace.makeOffer({
      params: { listingId: l.id },
      body: { name: "Mary Wanjiru", email: "MARY@example.test", amountMinor: 1_700_000_000, message: "Cash buyer" },
    });
    expect(offer.status).toBe("pending");
    const lead = await A.agent.api.agency.getLead({ params: { ...P(), leadId } });
    expect(lead.lead.stage).toBe("offer"); // same person (e-mail matched case-insensitively), same lead
    expect(lead.offers.map((o) => o.amountMinor)).toEqual([1_700_000_000]);
    // still one contact (matched by e-mail), now also a buyer
    const again = await A.manager.api.contacts.listContacts({ params: P(), query: { q: "Wanjiru" } });
    expect(again.contacts.map((c) => [c.id, c.tags])).toEqual([[mary, ["buyer", "enquirer"]]]);
    await mgr.respondOffer({
      params: { ...P(), offerId: lead.offers[0]!.id },
      body: { action: "counter", counterMinor: 1_800_000_000 },
    });
    await refused(
      S.api.marketplace.acceptCounter({ params: { reference: offer.reference }, body: { token: "x".repeat(32) } }),
      404,
    );
    const accepted = await S.api.marketplace.acceptCounter({
      params: { reference: offer.reference },
      body: { token: offer.token },
    });
    expect(accepted).toMatchObject({ status: "accepted", amountMinor: 1_800_000_000 });

    // the manager closes the deal: commission 3 % of 18,000,000.00 = 540,000.00 + VAT 86,400.00; agent share 135,000.00
    const { deal, commission } = await mgr.closeDeal({
      params: P(),
      body: { listingId: l.id, agreementId: agr.id, offerId: lead.offers[0]!.id, closedOn: "2026-10-17" },
    });
    expect(deal.valueMinor).toBe(1_800_000_000);
    expect(commission).toMatchObject({
      commissionMinor: 54_000_000,
      vatMinor: 8_640_000,
      totalMinor: 62_640_000,
      agentShareMinor: 13_500_000,
      agentUserId: A.agent.userId,
      status: "pending_approval",
    });
    expect((await A.agent.api.agency.getLead({ params: { ...P(), leadId } })).lead.stage).toBe("won");
    expect((await mgr.getListing({ params: { ...P(), listingId: l.id } })).status).toBe("closed");
    expect((await S.api.marketplace.search({ query: {} })).total).toBe(0); // off the marketplace
    // nothing is in the ledger until a second person approves
    expect(await ledgerBalance(S, A.orgId, "4700")).toBe(0);

    // the accountant approves (the manager raised it); the ledger now holds exactly the commission
    const approved = await A.accountant.api.agency.decideCommission({
      params: { ...P(), commissionId: commission.id },
      body: { decision: "approve" },
    });
    expect(approved.status).toBe("approved");
    expect(await ledgerBalance(S, A.orgId, "1180")).toBe(62_640_000);
    expect(await ledgerBalance(S, A.orgId, "4700")).toBe(-54_000_000);
    expect(await ledgerBalance(S, A.orgId, "2100")).toBe(-8_640_000);
    expect(await ledgerBalance(S, A.orgId, "5710")).toBe(13_500_000);
    expect(await ledgerBalance(S, A.orgId, "2480")).toBe(-13_500_000);

    // money received is recorded in two parts; each bank reference once
    await A.accountant.api.agency.commissionReceipt({
      params: { ...P(), commissionId: commission.id },
      body: { amountMinor: 40_000_000, reference: "BANK-TT-001", receivedOn: "2026-10-17" },
    });
    await refused(
      A.accountant.api.agency.commissionReceipt({
        params: { ...P(), commissionId: commission.id },
        body: { amountMinor: 1_000, reference: "BANK-TT-001", receivedOn: "2026-10-17" },
      }),
      409,
    );
    await refused(
      A.accountant.api.agency.commissionReceipt({
        params: { ...P(), commissionId: commission.id },
        body: { amountMinor: 30_000_000, reference: "BANK-TT-002", receivedOn: "2026-10-17" },
      }),
      400,
    ); // more than is still due
    const paid = await A.accountant.api.agency.commissionReceipt({
      params: { ...P(), commissionId: commission.id },
      body: { amountMinor: 22_640_000, reference: "BANK-TT-002", receivedOn: "2026-10-17" },
    });
    expect(paid).toMatchObject({ status: "paid", receivedMinor: 62_640_000 });

    // the commission register and the ledger agree
    const reg = await A.fd.api.agency.listCommissions({ params: P() });
    expect(reg.totals).toEqual({
      approvedCommissionMinor: 54_000_000,
      approvedVatMinor: 8_640_000,
      receivedMinor: 62_640_000,
      outstandingMinor: 0,
      ledgerIncomeMinor: 54_000_000,
      ledgerReceivableMinor: 0,
    });
    expect(reg.totals.ledgerIncomeMinor).toBe(reg.totals.approvedCommissionMinor);
    expect(reg.totals.ledgerReceivableMinor).toBe(reg.totals.outstandingMinor);
    const tb = await A.fd.api.ledger.trialBalance({ params: P(), query: {} });
    expect(tb.totals.debitMinor).toBe(tb.totals.creditMinor);

    // the summary reads the funnel and the ledger
    const sum = await A.auditor.api.agency.summary({ params: P(), query: { from: "2026-10-01", to: "2026-10-31" } });
    expect(sum.funnel).toEqual({ enquiries: 1, leads: 1, viewings: 1, offers: 1, won: 1 });
    expect(sum.listings).toEqual({ closed: 1, draft: 1 }); // the first draft was never submitted
    expect(sum.ledger.commissionIncomeMinor).toBe(54_000_000);

    // listing performance: views → enquiries → leads → viewings → offers → deal
    const perf = await A.manager.api.agency.listingPerformance({
      params: P(),
      query: { from: "2026-10-01", to: "2026-10-31" },
    });
    expect(perf.listings.find((x) => x.listingId === l.id)).toMatchObject({
      views: 2,
      enquiries: 1,
      leads: 1,
      viewings: 1,
      offers: 1,
      closed: true,
      enquiryRatePct: 50,
    });
    expect(perf.sources).toEqual([{ source: "PALTAS marketplace", leads: 1, won: 1 }]);

    // every step is in the audit trail
    const audit = await A.admin.api.organisations.listAudit({ params: P(), query: { limit: 200 } });
    const actions = audit.entries.map((e) => e.action);
    for (const a of [
      "Listing drafted",
      "Listing submitted for review",
      "Listing approved and published by PALTAS",
      "Marketplace viewing request received",
      "Enquiry converted to a lead",
      "Marketplace offer received",
      "Counter-offer accepted by the buyer",
      "Deal closed — commission raised for approval",
      "Commission approved and posted",
      "Commission receipt recorded",
    ])
      expect(actions).toContain(a);
  });
});
