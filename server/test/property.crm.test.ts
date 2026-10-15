// The letting pipeline on the one contact store: enquiries reuse contacts and open leads (and an idempotency key never
// creates a second lead), viewings refuse clashes and let units, applications are screened by one person and decided by
// another, and an approved application becomes a lease whose activation wins the lead.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pmOrg, setUpBuilding, startPropertyServer, type Building, type PmStaff } from "./support/property-fixture.js";
import { refused, type Person, type TestServer } from "./support/test-server.js";

describe("Property Management CRM pipeline", () => {
  let S: TestServer;
  let orgId: string;
  let st: PmStaff;
  let agent: Person;
  let pm: Person;
  let fd: Person;
  let B: Building;
  let leadId: string;
  let contactId: string;
  const O = () => ({ orgId });

  beforeAll(async () => {
    S = await startPropertyServer();
    S.setToday("2026-10-12");
    const o = await pmOrg(S, { name: "Letting Org" });
    orgId = o.orgId;
    st = o.staff;
    agent = st.leasing_agent;
    pm = st.property_manager;
    fd = st.finance_director;
    B = await setUpBuilding(orgId, pm, { units: ["C-1", "C-2"] });
  });
  afterAll(() => S.close());

  it("an enquiry finds or adds the contact and reuses an open lead; an idempotency key records once", async () => {
    const first = await agent.api.property.createEnquiry({
      params: O(),
      body: {
        name: "Esther Muthoni",
        email: "esther.m@example.com",
        phone: "0712 401 900",
        unitId: B.units["C-1"]!,
        source: "PALTAS website",
        message: "Is C-1 available from November?",
        consent: { email: true, sms: false, marketing: false },
        idempotencyKey: "web-form-0001",
      },
    });
    expect(first).toMatchObject({ contactReused: false, leadReused: false });
    expect(first.lead).toMatchObject({ stage: "new", unitId: B.units["C-1"], agentId: agent.userId });
    leadId = first.lead.id;
    contactId = first.lead.contactId;
    const replay = await agent.api.property.createEnquiry({
      params: O(),
      body: { name: "Esther Muthoni", email: "esther.m@example.com", idempotencyKey: "web-form-0001" },
    });
    expect(replay.lead.id).toBe(leadId);
    const repeat = await agent.api.property.createEnquiry({
      params: O(),
      body: { name: "E. Muthoni", phone: "+254712401900", unitId: B.units["C-1"]!, source: "Phone" },
    });
    expect(repeat).toMatchObject({ contactReused: true, leadReused: true });
    expect(repeat.lead.id).toBe(leadId);
    const otherUnit = await agent.api.property.createEnquiry({
      params: O(),
      body: { name: "Esther Muthoni", email: "ESTHER.M@example.com", unitId: B.units["C-2"]!, source: "Walk-in" },
    });
    expect(otherUnit).toMatchObject({ contactReused: true, leadReused: false });
    await refused(agent.api.property.createEnquiry({ params: O(), body: { name: "No Contact Details" } }), 400);
    const c = await agent.api.contacts.getContact({ params: { orgId, contactId } });
    expect(c.contact.types).toEqual(["prospect"]);
    expect(c.messages.map((m) => [m.direction, m.status])).toEqual([["in", "received"]]);
    expect(c.activities.filter((a) => a.kind === "enquiry").length).toBe(3);
    // the duplicate lead for the other unit is lost, with its reason
    const lost = await agent.api.property.loseLead({
      params: { orgId, leadId: otherUnit.lead.id },
      body: { reason: "chose_competitor", note: "Prefers C-1" },
    });
    expect(lost).toMatchObject({ stage: "lost", lostReason: "chose_competitor" });
    await refused(
      agent.api.property.moveLead({ params: { orgId, leadId: otherUnit.lead.id }, body: { stage: "contacted" } }),
      409,
    );
  });

  it("books viewings without clashes for the agent, and records the outcome", async () => {
    await agent.api.property.moveLead({
      params: { orgId, leadId },
      body: { stage: "qualified", note: "Budget confirmed" },
    });
    await refused(
      agent.api.property.scheduleViewing({ params: O(), body: { leadId, date: "2026-10-01", time: "10:00" } }),
      400,
    );
    const v = await agent.api.property.scheduleViewing({
      params: O(),
      body: { leadId, date: "2026-10-14", time: "10:00" },
    });
    expect(v.status).toBe("scheduled");
    const other = await agent.api.property.createEnquiry({
      params: O(),
      body: { name: "Brian Otieno", email: "brian@example.com", unitId: B.units["C-2"]!, source: "Portal" },
    });
    await refused(
      agent.api.property.scheduleViewing({
        params: O(),
        body: { leadId: other.lead.id, date: "2026-10-14", time: "10:30" },
      }),
      409,
    );
    await agent.api.property.scheduleViewing({
      params: O(),
      body: { leadId: other.lead.id, date: "2026-10-14", time: "11:00" },
    });
    const out = await agent.api.property.viewingOutcome({
      params: { orgId, viewingId: v.id },
      body: { attended: true, feedback: "Loved the light", interest: 4 },
    });
    expect(out).toMatchObject({ status: "completed", interest: 4 });
    await refused(
      agent.api.property.viewingOutcome({ params: { orgId, viewingId: v.id }, body: { attended: false } }),
      409,
    );
    const leads = await agent.api.property.listLeads({ params: O(), query: { stage: "viewed" } });
    expect(leads.leads.map((l) => l.id)).toEqual([leadId]);
  });

  it("an application is screened by one person and decided by another; only an approved one becomes a lease", async () => {
    const app = await agent.api.property.startApplication({
      params: O(),
      body: {
        leadId,
        employer: "Safaricom PLC",
        incomeMinor: 35_000_000,
        occupants: 2,
        offer: { rentMinor: 8_500_000, depositMinor: 17_000_000, startDate: "2026-11-01", months: 12 },
      },
    });
    expect(app.status).toBe("submitted");
    await refused(
      agent.api.property.startApplication({
        params: O(),
        body: { leadId, offer: { rentMinor: 1, depositMinor: 0, startDate: "2026-11-01", months: 12 } },
      }),
      409,
    );
    await refused(agent.api.property.convertApplication({ params: { orgId, applicationId: app.id } }), 403);
    await pm.api.property.screenApplication({
      params: { orgId, applicationId: app.id },
      body: { identity: true, income: true, reference: false },
    });
    // the screener cannot decide; an agent has no approval right; checks must be complete
    await refused(
      pm.api.property.decideApplication({ params: { orgId, applicationId: app.id }, body: { approve: true } }),
      403,
      "SEPARATION_OF_DUTIES",
    );
    await refused(
      agent.api.property.decideApplication({ params: { orgId, applicationId: app.id }, body: { approve: true } }),
      403,
      "ROLE_NOT_ALLOWED",
    );
    await refused(
      fd.api.property.decideApplication({ params: { orgId, applicationId: app.id }, body: { approve: true } }),
      409,
    );
    await pm.api.property.screenApplication({
      params: { orgId, applicationId: app.id },
      body: { identity: true, income: true, reference: true },
    });
    await refused(pm.api.property.convertApplication({ params: { orgId, applicationId: app.id } }), 409);
    const approved = await fd.api.property.decideApplication({
      params: { orgId, applicationId: app.id },
      body: { approve: true, note: "Income 4x rent" },
    });
    expect(approved).toMatchObject({ status: "approved", screenedBy: pm.userId, approvedBy: fd.userId });
    const { lease, application } = await pm.api.property.convertApplication({
      params: { orgId, applicationId: app.id },
    });
    expect(application.status).toBe("converted");
    expect(lease).toMatchObject({
      status: "draft",
      tenantId: contactId,
      startDate: "2026-11-01",
      endDate: "2027-10-31",
      rentMinor: 8_500_000,
      depositMinor: 17_000_000,
    });
    const again = await pm.api.property.convertApplication({ params: { orgId, applicationId: app.id } });
    expect(again.lease.id).toBe(lease.id);
    const activated = await pm.api.property.activateLease({
      params: { orgId, leaseId: lease.id },
      body: { signedOn: "2026-10-12" },
    });
    expect(activated.depositInvoice?.amountMinor).toBe(17_000_000);
    const won = (await agent.api.property.listLeads({ params: O(), query: { stage: "won" } })).leads;
    expect(won.map((l) => l.id)).toEqual([leadId]);
    const c = await pm.api.contacts.getContact({ params: { orgId, contactId } });
    expect(c.contact.types.sort()).toEqual(["prospect", "tenant"]);
    const kinds = new Set(c.activities.map((a) => a.kind));
    for (const k of ["enquiry", "stage", "viewing", "application", "lease"])
      expect(kinds.has(k as never), k).toBe(true);
    // the let unit can no longer be viewed
    const late = await agent.api.property.createEnquiry({
      params: O(),
      body: { name: "Late Lead", email: "late@example.com", unitId: B.units["C-1"]!, source: "Portal" },
    });
    await refused(
      agent.api.property.scheduleViewing({
        params: O(),
        body: { leadId: late.lead.id, date: "2026-11-15", time: "09:00" },
      }),
      409,
    );
  });
});
