// Security records never cross organisations: another organisation's ids answer "not found" on every kind of record,
// lists show only the caller's own records, a client-portal member sees only the clients linked to them, alarm
// accounts route to their own organisation, and a workspace the organisation does not hold is "not found".
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  alarmEvent,
  buildOps,
  eat,
  securityOrg,
  startSecurityServer,
  workOctober,
  type Staff,
  type TestOps,
} from "./support/security-fixture.js";
import { refused, type TestServer } from "./support/test-server.js";

describe("security isolation", () => {
  let S: TestServer;
  let A: { orgId: string; st: Staff; ops: TestOps };
  let B: { orgId: string; st: Staff; ops: TestOps };
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    S = await startSecurityServer();
    const a = await securityOrg(S, "Alpha Guards");
    const b = await securityOrg(S, "Bravo Guards");
    A = {
      orgId: a.orgId,
      st: a.staff,
      ops: await buildOps(a.orgId, a.staff, { name: "Alpha Plaza", accountRef: "ALPHA-1" }),
    };
    B = {
      orgId: b.orgId,
      st: b.staff,
      ops: await buildOps(b.orgId, b.staff, { name: "Bravo Mall", accountRef: "BRAVO-1" }),
    };
    const w = await workOctober(A.orgId, A.st, A.ops);
    ids.shift = w.a1;
    const sec = A.st.operations_manager.api.security;
    const P = { orgId: A.orgId };
    ids.incident = (
      await sec.reportIncident({
        params: P,
        body: {
          siteId: A.ops.siteId,
          type: "Trespass",
          severity: "medium",
          description: "Person climbed the fence",
          occurredAt: eat("2026-10-05", "20:00"),
        },
      })
    ).id;
    ids.alarm = (
      await sec.raiseAlarm({
        params: P,
        body: { siteId: A.ops.siteId, at: eat("2026-10-05", "20:00"), detail: "Call from site" },
      })
    ).id;
    ids.visitor = (
      await A.st.gate_officer.api.security.registerVisitor({
        params: P,
        body: {
          kind: "walk_in",
          siteId: A.ops.siteId,
          name: "Rose Akinyi",
          host: "Tower 2",
          purpose: "Meeting",
          idType: "passport",
          idLast4: "9X21",
        },
      })
    ).id;
    ids.watch = (
      await A.st.gate_officer.api.security.addWatch({
        params: P,
        body: { kind: "person", value: "J. Ndegwa", reason: "Access revoked by client" },
      })
    ).id;
    const ax = A.st.access_administrator.api.security;
    const door = await ax.createDoor({
      params: P,
      body: { siteId: A.ops.siteId, code: "D-A-1", name: "Gate", zone: "Perimeter" },
    });
    ids.door = door.id;
    const group = await ax.saveAccessGroup({
      params: P,
      body: { name: "Alpha guards", doorIds: [door.id], from: "00:00", to: "00:00" },
    });
    ids.credential = (
      await ax.issueCredential({
        params: P,
        body: {
          holderName: "Janet Moraa",
          kind: "fob",
          groupIds: [group.id],
          validFrom: "2026-10-01",
          validTo: "2027-09-30",
        },
      })
    ).id;
    ids.equipment = (await sec.createEquipment({ params: P, body: { code: "BC-07", kind: "Body camera" } })).id;
    ids.patrol = (
      await A.st.guardA.api.security.startPatrol({
        params: P,
        body: { siteId: A.ops.siteId, guardId: A.ops.guards.A, startedAt: eat("2026-10-05", "08:00") },
      })
    ).id;
    ids.occurrence = (
      await sec.addOccurrence({
        params: P,
        body: { siteId: A.ops.siteId, kind: "entry", text: "Handover done", at: eat("2026-10-05", "18:00") },
      })
    ).id;
    const run = await A.st.accountant.api.security.runBilling({ params: P, body: { period: "2026-10" } });
    ids.invoice = run.invoices[0]!.id;
    ids.bankLine = (
      await A.st.accountant.api.security.importBankLines({
        params: P,
        body: { lines: [{ date: "2026-10-11", description: "EFT IN", reference: "EFT-A1", amountMinor: 1_000 }] },
      })
    ).lines[0]!.id;
  });
  afterAll(() => S.close());

  it("another organisation's records answer 'not found' — through the caller's own organisation", async () => {
    const om = B.st.operations_manager.api.security;
    const P = { orgId: B.orgId };
    const nf = (p: Promise<unknown>) => refused(p, 404, "NOT_FOUND");
    await nf(om.getSite({ params: { ...P, siteId: A.ops.siteId } }));
    await nf(
      om.createPost({
        params: { ...P, siteId: A.ops.siteId },
        body: { name: "Steal", cover: "24h", guardsRequired: 1 },
      }),
    );
    await nf(
      om.updatePostOrder({ params: { ...P, postId: A.ops.gatePostId }, body: { orderText: "Hijacked order text" } }),
    );
    await nf(
      om.createCheckpoints({
        params: { ...P, siteId: A.ops.siteId },
        body: { checkpoints: [{ code: "X", name: "X", tagRef: "TAG-X", offsetMinutes: 0 }] },
      }),
    );
    await nf(
      om.createContract({
        params: P,
        body: {
          clientId: A.ops.clientId,
          siteId: B.ops.siteId,
          startDate: "2026-10-01",
          monthlyFeeMinor: 1,
          vatPct: 16,
        },
      }),
    );
    await nf(
      om.endContract({
        params: { ...P, contractId: A.ops.contractId },
        body: { endDate: "2026-10-31", reason: "Not ours to end" },
      }),
    );
    await nf(om.updateGuard({ params: { ...P, guardId: A.ops.guards.A }, body: { status: "suspended" } }));
    await nf(
      om.addTraining({ params: { ...P, guardId: A.ops.guards.A }, body: { course: "X", validTo: "2027-01-01" } }),
    );
    await nf(om.assignShift({ params: { ...P, shiftId: ids.shift! }, body: { guardId: B.ops.guards.A } }));
    await nf(om.assignShift({ params: { ...P, shiftId: ids.shift! }, body: { guardId: A.ops.guards.A } }));
    await nf(om.unassignShift({ params: { ...P, shiftId: ids.shift! }, body: { reason: "Not ours to change" } }));
    await nf(om.approveTimesheets({ params: P, body: { shiftIds: [ids.shift!] } }));
    await nf(om.getIncident({ params: { ...P, incidentId: ids.incident! } }));
    await nf(
      om.closeIncident({ params: { ...P, incidentId: ids.incident! }, body: { note: "Closing someone else's" } }),
    );
    await nf(
      om.addOccurrence({
        params: P,
        body: {
          siteId: B.ops.siteId,
          kind: "correction",
          correctsId: ids.occurrence!,
          text: "Not ours",
          at: eat("2026-10-05", "19:00"),
        },
      }),
    );
    await nf(
      om.listOccurrences({
        params: P,
        query: { siteId: A.ops.siteId, from: eat("2026-10-01", "00:00"), to: eat("2026-11-01", "00:00") },
      }),
    );
    await nf(
      B.st.control_room_operator.api.security.acknowledgeAlarm({
        params: { ...P, alarmId: ids.alarm! },
        body: { at: eat("2026-10-05", "20:05") },
      }),
    );
    await nf(
      B.st.supervisor.api.security.scanCheckpoint({
        params: { ...P, patrolId: ids.patrol! },
        body: { tagRef: "NFC-0001", scannedAt: eat("2026-10-05", "08:01"), method: "nfc" },
      }),
    );
    await nf(
      B.st.gate_officer.api.security.visitorAction({
        params: { ...P, visitorId: ids.visitor! },
        body: { action: "host_approved", at: eat("2026-10-11", "10:00") },
      }),
    );
    await nf(
      B.st.gate_officer.api.security.removeWatch({
        params: { ...P, entryId: ids.watch! },
        body: { reason: "Not ours to remove" },
      }),
    );
    const ax = B.st.access_administrator.api.security;
    await nf(
      ax.changeCredential({
        params: { ...P, credentialId: ids.credential! },
        body: { action: "revoke", reason: "Not ours to revoke" },
      }),
    );
    await nf(ax.remoteUnlock({ params: { ...P, doorId: ids.door! }, body: { reason: "Open someone else's door" } }));
    await nf(om.issueEquipment({ params: { ...P, equipmentId: ids.equipment! }, body: { guardId: B.ops.guards.A } }));
    const fin = B.st.accountant.api.security;
    await nf(
      fin.recordReceipt({
        params: P,
        body: {
          clientId: A.ops.clientId,
          date: "2026-10-11",
          method: "cash",
          reference: "X-1",
          allocations: [{ invoiceId: ids.invoice!, amountMinor: 1 }],
        },
      }),
    );
    await nf(
      fin.recordReceipt({
        params: P,
        body: {
          clientId: B.ops.clientId,
          date: "2026-10-11",
          method: "cash",
          reference: "X-2",
          allocations: [{ invoiceId: ids.invoice!, amountMinor: 1 }],
        },
      }),
    );
    await nf(
      fin.recordCertificate({
        params: { ...P, invoiceId: ids.invoice! },
        body: { kind: "vat", certificateRef: "WHT-X1", date: "2026-10-11" },
      }),
    );
    await nf(fin.clientStatement({ params: { ...P, clientId: A.ops.clientId } }));
    await nf(fin.billLateFee({ params: { ...P, clientId: A.ops.clientId }, body: { vatPct: 16 } }));
    await nf(
      fin.matchBankLine({
        params: { ...P, lineId: ids.bankLine! },
        body: { invoiceId: ids.invoice!, method: "bank_transfer" },
      }),
    );
    await nf(fin.clientReport({ params: { ...P, clientId: A.ops.clientId }, query: { month: "2026-10" } }));
    // and nobody outside an organisation reaches it at all
    await nf(om.listSites({ params: { orgId: A.orgId } }));
  });

  it("lists show only the organisation's own records; billing never touched the other ledger", async () => {
    const P = { orgId: B.orgId };
    const om = B.st.operations_manager.api.security;
    expect((await om.listSites({ params: P })).sites.map((s) => s.name)).toEqual(["Bravo Mall"]);
    expect((await om.listGuards({ params: P, query: {} })).guards.map((g) => g.id).sort()).toEqual(
      Object.values(B.ops.guards).sort(),
    );
    expect((await om.listIncidents({ params: P, query: {} })).incidents).toEqual([]);
    expect((await om.listAlarms({ params: P, query: {} })).alarms).toEqual([]);
    expect(
      (await om.listShifts({ params: P, query: { from: eat("2026-10-01", "00:00"), to: eat("2026-11-01", "00:00") } }))
        .shifts,
    ).toEqual([]);
    expect((await B.st.gate_officer.api.security.listVisitors({ params: P, query: { view: "log" } })).visitors).toEqual(
      [],
    );
    expect((await B.st.gate_officer.api.security.listWatchlist({ params: P })).entries).toEqual([]);
    const ax = await om.accessOverview({ params: P });
    expect([ax.doors, ax.credentials, ax.decisions]).toEqual([[], [], []]);
    expect((await B.st.accountant.api.security.listInvoices({ params: P, query: {} })).invoices).toEqual([]);
    expect((await B.st.accountant.api.security.listBankLines({ params: P })).lines).toEqual([]);
    const links = await S.sql("SELECT count(*)::int AS n FROM sec_ledger_links WHERE org_id = $1", [B.orgId]);
    expect(links[0].n).toBe(0);
    const k = await B.st.accountant.api.security.financeKpis({
      params: P,
      query: { from: "2026-01-01", to: "2026-12-31" },
    });
    expect(k.revenueMinor).toBe(0);
  });

  it("the client portal shows only the clients linked to the member", async () => {
    const om = A.st.operations_manager.api.security;
    const P = { orgId: A.orgId };
    const other = await om.createClient({
      params: P,
      body: { name: "Riverside Residents Assoc.", contactName: "Jane Mwangi", paymentTermsDays: 15 },
    });
    await om.createSite({
      params: P,
      body: { clientId: other.id, name: "Riverside Estate", kind: "Residential estate" },
    });
    const cl = A.st.security_client;
    // before being linked the member sees nothing
    expect((await cl.api.security.portal({ params: P, query: { month: "2026-10" } })).clients).toEqual([]);
    await refused(
      om.setClientPortalUsers({
        params: { ...P, clientId: A.ops.clientId },
        body: { userIds: [A.st.accountant.userId] },
      }),
      400,
    );
    await om.setClientPortalUsers({ params: { ...P, clientId: A.ops.clientId }, body: { userIds: [cl.userId] } });
    const portal = await cl.api.security.portal({ params: P, query: { month: "2026-10" } });
    expect(portal.clients.map((c) => c.report.clientId)).toEqual([A.ops.clientId]);
    expect(portal.clients[0]!.invoices.map((i) => i.id)).toEqual([ids.invoice]);
    const rep = await cl.api.security.clientReport({
      params: { ...P, clientId: A.ops.clientId },
      query: { month: "2026-10" },
    });
    expect(rep.sites[0]).toMatchObject({
      name: "Alpha Plaza",
      shiftsRequired: 4,
      shiftsCovered: 4,
      incidents: 1,
      responseTargetMinutes: 10,
    });
    await refused(
      cl.api.security.clientReport({ params: { ...P, clientId: other.id }, query: { month: "2026-10" } }),
      404,
      "NOT_FOUND",
    );
    await refused(
      cl.api.security.clientStatement({ params: { ...P, clientId: A.ops.clientId } }),
      403,
      "ROLE_NOT_ALLOWED",
    );
    await refused(cl.api.security.listSites({ params: P }), 403, "ROLE_NOT_ALLOWED");
    // staff use the reports, not the portal
    await refused(A.st.operations_manager.api.security.portal({ params: P, query: { month: "2026-10" } }), 403);
  });

  it("an alarm account routes to its own organisation only", async () => {
    const r = await alarmEvent(S, {
      accountRef: "BRAVO-1",
      eventId: "EV-B1",
      kind: "fire",
      occurredAt: eat("2026-10-11", "03:00"),
    });
    expect(r.status).toBe(200);
    const b = await B.st.control_room_operator.api.security.listAlarms({ params: { orgId: B.orgId }, query: {} });
    expect(b.alarms.map((a) => a.id)).toEqual([r.body.alarmId]);
    const a = await A.st.control_room_operator.api.security.listAlarms({ params: { orgId: A.orgId }, query: {} });
    expect(a.alarms.map((x) => x.id)).not.toContain(r.body.alarmId);
  });

  it("an organisation without the security product does not have the workspace", async () => {
    const h = await S.newOrg({ name: "Hotel Only", product: "hotel", plan: "HOTEL-STD", trial: false });
    await refused(h.admin.api.security.listSites({ params: { orgId: h.orgId } }), 404, "NOT_FOUND");
    await refused(h.admin.api.security.dashboard({ params: { orgId: h.orgId } }), 404, "NOT_FOUND");
  });
});
