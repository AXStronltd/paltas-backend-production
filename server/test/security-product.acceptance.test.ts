// Security Services end to end: a security company sets up a client site and contract, rosters guards, records
// attendance evidence, patrols, alarms and incidents, runs the gate and access control, issues equipment, bills the
// client and pays the guards — every money step posted to the one ledger, every external system a labelled test adapter.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  alarmEvent,
  buildOps,
  eat,
  FAR_POS,
  SITE_POS,
  securityOrg,
  startSecurityServer,
  workOctober,
  type Staff,
  type TestOps,
} from "./support/security-fixture.js";
import { refused, type TestServer } from "./support/test-server.js";

describe("security services — acceptance", () => {
  let S: TestServer;
  let orgId: string;
  let st: Staff;
  let ops: TestOps;
  const P = () => ({ orgId });

  beforeAll(async () => {
    S = await startSecurityServer();
    const o = await securityOrg(S, "Usalama Guards");
    orgId = o.orgId;
    st = o.staff;
    ops = await buildOps(orgId, st);
  });
  afterAll(() => S.close());

  it("set-up: client, site with geofence and alarm account, posts with post orders, checkpoints, contract", async () => {
    const site = await st.supervisor.api.security.getSite({ params: { orgId, siteId: ops.siteId } });
    expect(site.geofence).toEqual({ ...SITE_POS, radiusM: 250 });
    expect(site.alarmMonitoring).toEqual({ provider: "sandboxalarm", accountRef: "WST-001" });
    expect(site.posts.map((p) => [p.name, p.orderVersion])).toEqual([
      ["Gate A", 1],
      ["Perimeter patrol", 0],
    ]);
    expect(site.checkpoints.map((c) => [c.code, c.seq])).toEqual([
      ["CP1", 1],
      ["CP2", 2],
      ["CP3", 3],
    ]);
    expect(site.contract).toMatchObject({
      monthlyFeeMinor: 118_000_000,
      vatPct: 16,
      patrolTargetPct: 95,
      responseMinutes: 10,
    });
    // one active contract per site
    await refused(
      st.operations_manager.api.security.createContract({
        params: P(),
        body: { clientId: ops.clientId, siteId: ops.siteId, startDate: "2026-10-01", monthlyFeeMinor: 1, vatPct: 16 },
      }),
      409,
      "CONFLICT",
    );
    // a new post-order version needs a new acknowledgement
    const v2 = await st.operations_manager.api.security.updatePostOrder({
      params: { orgId, postId: ops.gatePostId },
      body: { orderText: "Check every vehicle. Log every visitor. Barrier stays down after 22:00." },
    });
    expect(v2.orderVersion).toBe(2);
    await refused(
      st.guardA.api.security.acknowledgePostOrder({
        params: { orgId, postId: ops.gatePostId },
        body: { guardId: ops.guards.A, version: 1 },
      }),
      409,
    );
    const settings = await st.operations_manager.api.security.updateSettings({ params: P(), body: { lateFeePct: 2 } });
    expect(settings).toMatchObject({ lateFeePct: 2, licenceAlertDays: 30, minRestHours: 8 });
  });

  it("sales pipeline: enquiry → survey → quote (margin from configured rates) → won creates the client", async () => {
    const api = st.operations_manager.api.security;
    const o = await api.createOpportunity({
      params: P(),
      body: { name: "Thika Rd Warehouse", guardsPerShift: 2, grade: "Guard" },
    });
    await api.moveOpportunity({
      params: { orgId, opportunityId: o.id },
      body: { stage: "survey", surveyDate: "2026-10-14" },
    });
    const q = await api.moveOpportunity({
      params: { orgId, opportunityId: o.id },
      body: { stage: "quoted", monthlyQuoteMinor: 200_000_000 },
    });
    // 2 guards × 24 h × 30 days × 100.00 = 144,000.00 wages + 6 % employer pension = 152,640.00
    expect(q.estimatedMonthlyCostMinor).toBe(15_264_000);
    expect(q.marginPct).toBe(92.4);
    await refused(api.moveOpportunity({ params: { orgId, opportunityId: o.id }, body: { stage: "won" } }), 400);
    const won = await api.moveOpportunity({
      params: { orgId, opportunityId: o.id },
      body: {
        stage: "won",
        client: { name: "Thika Road Logistics", contactName: "Hussein Abdi", paymentTermsDays: 30 },
      },
    });
    expect(won.clientId).toBeTruthy();
    expect((await api.listClients({ params: P() })).clients.map((c) => c.name)).toContain("Thika Road Logistics");
    await refused(api.moveOpportunity({ params: { orgId, opportunityId: o.id }, body: { stage: "lost" } }), 409);
  });

  it("roster: assignment rules, offers, publishing and coverage", async () => {
    const om = st.operations_manager.api.security;
    const [day, night] = (
      await om.createShifts({
        params: P(),
        body: {
          postId: ops.gatePostId,
          shifts: [
            { startsAt: eat("2026-10-20", "06:00"), endsAt: eat("2026-10-20", "18:00") },
            { startsAt: eat("2026-10-20", "18:00"), endsAt: eat("2026-10-21", "06:00") },
          ],
        },
      })
    ).shifts;
    await om.assignShift({ params: { orgId, shiftId: day!.id }, body: { guardId: ops.guards.A } });
    const rest = await refused(
      om.assignShift({ params: { orgId, shiftId: night!.id }, body: { guardId: ops.guards.A } }),
      409,
    );
    expect(rest.message).toMatch(/less than 8 hours' rest/);
    const offer = await om.offerShift({ params: { orgId, shiftId: night!.id } });
    expect(offer.eligibleGuardIds).toEqual([ops.guards.B]);
    expect(offer.delivery).toMatch(/not sent/);
    await om.assignShift({ params: { orgId, shiftId: night!.id }, body: { guardId: ops.guards.B } });
    const pub = await om.publishRoster({
      params: P(),
      body: { from: eat("2026-10-20", "00:00"), to: eat("2026-10-22", "00:00") },
    });
    expect(pub).toEqual({ published: 2, delivery: "Recorded — not sent (no messaging provider connected)" });
    const cov = await st.supervisor.api.security.rosterCoverage({
      params: P(),
      query: { from: "2026-10-20", to: "2026-10-20" },
    });
    expect(cov.days).toEqual([{ siteId: ops.siteId, date: "2026-10-20", required: 2, assigned: 2, open: 0 }]);
    // taking the guard off returns the shift to open; cancelling removes it from coverage
    const back = await om.unassignShift({ params: { orgId, shiftId: night!.id }, body: { reason: "Guard on leave" } });
    expect(back).toMatchObject({ status: "open", guardId: null, publishedAt: null });
    await om.unassignShift({
      params: { orgId, shiftId: night!.id },
      body: { cancel: true, reason: "Client cancelled night cover" },
    });
    await om.unassignShift({
      params: { orgId, shiftId: day!.id },
      body: { cancel: true, reason: "Client cancelled day cover" },
    });
  });

  it("attendance: evidence recorded as submitted, geofence computed, post order enforced, no-shows raise alarms", async () => {
    const om = st.operations_manager.api.security;
    const [shift] = (
      await om.createShifts({
        params: P(),
        body: {
          postId: ops.gatePostId,
          shifts: [{ startsAt: eat("2026-10-03", "06:00"), endsAt: eat("2026-10-03", "18:00") }],
        },
      })
    ).shifts;
    await om.assignShift({ params: { orgId, shiftId: shift!.id }, body: { guardId: ops.guards.A } });
    const body = {
      capturedAt: eat("2026-10-03", "05:58"),
      method: "biometric" as const,
      ...FAR_POS,
      deviceRef: "TAB-7",
    };
    const noAck = await refused(st.guardA.api.security.clockIn({ params: { orgId, shiftId: shift!.id }, body }), 409);
    expect(noAck.message).toMatch(/post order version 2/);
    // a guard acts only for themselves
    await refused(
      st.guardB.api.security.acknowledgePostOrder({
        params: { orgId, postId: ops.gatePostId },
        body: { guardId: ops.guards.A, version: 2 },
      }),
      403,
      "FORBIDDEN",
    );
    await st.guardA.api.security.acknowledgePostOrder({
      params: { orgId, postId: ops.gatePostId },
      body: { guardId: ops.guards.A, version: 2 },
    });
    await refused(
      st.guardA.api.security.clockIn({
        params: { orgId, shiftId: shift!.id },
        body: { ...body, capturedAt: eat("2026-10-03", "05:00") },
      }),
      409,
    );
    const ci = await st.guardA.api.security.clockIn({ params: { orgId, shiftId: shift!.id }, body });
    expect(ci.clockIn).toMatchObject({
      method: "biometric",
      lat: FAR_POS.lat,
      deviceRef: "TAB-7",
      insideGeofence: false,
      verified: false,
      verification: "Recorded as submitted — no biometric reader connected (test adapter)",
      recordedBy: st.guardA.userId,
    });
    expect(ci.clockIn!.distanceM).toBeGreaterThan(1900);
    const co = await st.guardA.api.security.clockOut({
      params: { orgId, shiftId: shift!.id },
      body: { capturedAt: eat("2026-10-03", "18:10"), method: "gps", ...SITE_POS },
    });
    expect(co.clockOut!.insideGeofence).toBe(true);
    expect(co.timesheet).toMatchObject({ status: "submitted", normalMinutes: 720, overtimeMinutes: 12 });
    // the occurrence book notes the clock-in outside the geofence
    const book = await st.supervisor.api.security.listOccurrences({
      params: P(),
      query: { siteId: ops.siteId, from: eat("2026-10-03", "00:00"), to: eat("2026-10-04", "00:00") },
    });
    expect(book.entries.map((e) => e.text)).toEqual([
      expect.stringMatching(/clocked in — OUTSIDE the geofence/),
      expect.stringMatching(/clocked out/),
    ]);
    await om.approveTimesheets({ params: P(), body: { shiftIds: [shift!.id] } });

    // a shift nobody clocked in to becomes a no-show with an alarm, once
    const [missed] = (
      await om.createShifts({
        params: P(),
        body: {
          postId: ops.gatePostId,
          shifts: [{ startsAt: eat("2026-10-04", "06:00"), endsAt: eat("2026-10-04", "18:00") }],
        },
      })
    ).shifts;
    await om.assignShift({ params: { orgId, shiftId: missed!.id }, body: { guardId: ops.guards.B } });
    const ns = await st.control_room_operator.api.security.detectNoShows({ params: P() });
    expect(ns.shiftIds).toEqual([missed!.id]);
    expect((await st.control_room_operator.api.security.detectNoShows({ params: P() })).shiftIds).toEqual([]);
    const alarm = (
      await st.control_room_operator.api.security.listAlarms({ params: P(), query: { active: "true" } })
    ).alarms.find((a) => a.id === ns.alarmIds[0]);
    expect(alarm).toMatchObject({ source: "no_show", sourceRef: missed!.id, guardId: ops.guards.B, status: "raised" });
  });

  it("the October roster is worked and approved (feeds billing and payroll)", async () => {
    const w = await workOctober(orgId, st, ops);
    const ts = await st.auditor.api.security.listTimesheets({ params: P(), query: { status: "approved" } });
    const by = new Map(ts.shifts.map((s) => [s.id, s]));
    expect(by.get(w.a1)!.timesheet).toMatchObject({
      normalMinutes: 720,
      overtimeMinutes: 35,
      approvedBy: st.operations_manager.userId,
    });
    expect(by.get(w.a2)!.adjustment).toMatchObject({
      reason: expect.stringMatching(/battery/),
      by: st.supervisor.userId,
    });
    expect(by.get(w.a2)!.timesheet.normalMinutes).toBe(690);
    expect(by.get(w.b1)!.clockIn!.insideGeofence).toBe(false);
    expect(by.get(w.b2)).toMatchObject({ extra: true });
  });

  it("patrols: on-time, late and missed checkpoints; a missed one raises an alarm", async () => {
    const gb = st.guardB.api.security;
    const p = await gb.startPatrol({
      params: P(),
      body: { siteId: ops.siteId, guardId: ops.guards.B, startedAt: eat("2026-10-05", "19:00") },
    });
    await gb.scanCheckpoint({
      params: { orgId, patrolId: p.id },
      body: { tagRef: "NFC-0001", scannedAt: eat("2026-10-05", "19:02"), method: "nfc" },
    });
    await refused(
      st.guardA.api.security.scanCheckpoint({
        params: { orgId, patrolId: p.id },
        body: { tagRef: "NFC-0002", scannedAt: eat("2026-10-05", "19:10"), method: "nfc" },
      }),
      403,
    );
    await refused(
      gb.scanCheckpoint({
        params: { orgId, patrolId: p.id },
        body: { tagRef: "NFC-9999", scannedAt: eat("2026-10-05", "19:10"), method: "qr" },
      }),
      400,
    );
    await gb.scanCheckpoint({
      params: { orgId, patrolId: p.id },
      body: { tagRef: "NFC-0002", scannedAt: eat("2026-10-05", "19:25"), method: "qr" },
    });
    await refused(
      gb.scanCheckpoint({
        params: { orgId, patrolId: p.id },
        body: { tagRef: "NFC-0002", scannedAt: eat("2026-10-05", "19:26"), method: "qr" },
      }),
      409,
    );
    const closed = await gb.closePatrol({
      params: { orgId, patrolId: p.id },
      body: { closedAt: eat("2026-10-05", "19:50") },
    });
    expect(closed.patrol.checkpoints.map((c) => [c.code, c.state])).toEqual([
      ["CP1", "on_time"],
      ["CP2", "late"],
      ["CP3", "missed"],
    ]);
    expect(closed.patrol.compliancePct).toBe(33.3);
    expect(closed.alarmIds).toHaveLength(1);

    // control room: acknowledge (5 min), dispatch, resolve as genuine with an incident
    const cr = st.control_room_operator.api.security;
    const id = closed.alarmIds[0]!;
    await refused(
      cr.dispatchAlarm({ params: { orgId, alarmId: id }, body: { unit: "RV-2", at: eat("2026-10-05", "19:52") } }),
      409,
    );
    const ack = await cr.acknowledgeAlarm({ params: { orgId, alarmId: id }, body: { at: eat("2026-10-05", "19:55") } });
    expect(ack.responseMinutes).toBe(5);
    await cr.dispatchAlarm({ params: { orgId, alarmId: id }, body: { unit: "RV-2", at: eat("2026-10-05", "19:57") } });
    const done = await cr.resolveAlarm({
      params: { orgId, alarmId: id },
      body: {
        at: eat("2026-10-05", "20:20"),
        outcome: "genuine",
        note: "Fence cut near the basement ramp",
        incident: { type: "Perimeter breach", severity: "medium", description: "Fence cut near CP3; no entry found." },
      },
    });
    expect(done).toMatchObject({ status: "resolved", outcome: "genuine", dispatchUnit: "RV-2" });
    const inc = await st.supervisor.api.security.getIncident({ params: { orgId, incidentId: done.incidentId! } });
    expect(inc).toMatchObject({
      type: "Perimeter breach",
      alarmId: id,
      reportedBy: st.control_room_operator.userId,
      guardId: ops.guards.B,
    });
  });

  it("alarm providers deliver signed events; a repeat is ignored; guards raise panic for themselves", async () => {
    const ev = {
      accountRef: "WST-001",
      eventId: "EV-1001",
      kind: "intrusion",
      zone: "Z4",
      occurredAt: eat("2026-10-05", "21:00"),
    };
    const first = await alarmEvent(S, ev);
    expect(first.status).toBe(200);
    expect(first.body.duplicate).toBe(false);
    const again = await alarmEvent(S, ev);
    expect(again.body).toEqual({ ...first.body, duplicate: true });
    expect((await alarmEvent(S, ev, { secret: "whsec_wrong" })).status).toBe(401);
    expect((await alarmEvent(S, { ...ev, accountRef: "NOPE-1", eventId: "EV-2" })).status).toBe(404);
    const cr = st.control_room_operator.api.security;
    const ack = await cr.acknowledgeAlarm({
      params: { orgId, alarmId: first.body.alarmId },
      body: { at: eat("2026-10-05", "21:12") },
    });
    expect(ack).toMatchObject({
      source: "device",
      provider: "sandboxalarm",
      sourceRef: "EV-1001",
      responseMinutes: 12,
    });
    await cr.resolveAlarm({
      params: { orgId, alarmId: ack.id },
      body: { at: eat("2026-10-05", "21:30"), outcome: "false_alarm", note: "Cat in zone 4" },
    });

    await refused(
      st.guardA.api.security.raisePanic({
        params: P(),
        body: { guardId: ops.guards.B, siteId: ops.siteId, at: eat("2026-10-05", "22:00") },
      }),
      403,
    );
    const panic = await st.guardB.api.security.raisePanic({
      params: P(),
      body: { guardId: ops.guards.B, siteId: ops.siteId, at: eat("2026-10-05", "22:00"), ...SITE_POS },
    });
    expect(panic).toMatchObject({ source: "panic", status: "raised", guardId: ops.guards.B });
    expect(panic.detail).toMatch(/as submitted/);
  });

  it("incidents: facts fixed, investigator assigned, closed by someone other than the reporter", async () => {
    const sup = st.supervisor.api.security;
    const inc = await sup.reportIncident({
      params: P(),
      body: {
        siteId: ops.siteId,
        type: "Damaged barrier arm",
        severity: "low",
        description: "Barrier arm at Gate A hit by a delivery truck. Manual control in place.",
        occurredAt: eat("2026-10-06", "09:52"),
        attachments: [{ kind: "photo", ref: "upload://barrier-1.jpg" }],
      },
    });
    expect(inc.timeline).toHaveLength(1);
    expect(inc.timeline[0]).toMatchObject({
      kind: "incident",
      attachments: [{ kind: "photo", ref: "upload://barrier-1.jpg" }],
    });
    await refused(
      sup.closeIncident({ params: { orgId, incidentId: inc.id }, body: { note: "Barrier repaired" } }),
      403,
      "SEPARATION_OF_DUTIES",
    );
    const om = st.operations_manager.api.security;
    const inv = await om.assignInvestigator({
      params: { orgId, incidentId: inc.id },
      body: { userId: st.supervisor.userId },
    });
    expect(inv).toMatchObject({ status: "investigating", investigatorUserId: st.supervisor.userId });
    const closed = await om.closeIncident({
      params: { orgId, incidentId: inc.id },
      body: { note: "Barrier repaired by maintenance" },
    });
    expect(closed).toMatchObject({ status: "closed", closedBy: st.operations_manager.userId });
    expect(closed.timeline.map((e) => e.kind)).toEqual(["incident", "status", "status"]);
    await refused(
      om.closeIncident({ params: { orgId, incidentId: inc.id }, body: { note: "Barrier repaired again" } }),
      409,
    );
    const open = await st.auditor.api.security.listIncidents({ params: P(), query: { filter: "open" } });
    expect(open.incidents.map((i) => i.type)).toEqual(["Perimeter breach"]);
  });

  it("visitors and the watchlist: passes, walk-ins awaiting the host, check-in/out, matches refused and logged", async () => {
    const gate = st.gate_officer.api.security;
    await gate.addWatch({
      params: P(),
      body: { kind: "vehicle", value: "KDB 409L", reason: "Banned after trespass, Aug 2026" },
    });
    const lucy = await gate.registerVisitor({
      params: P(),
      body: {
        kind: "pre_registered",
        siteId: ops.siteId,
        name: "Lucy Wambui",
        host: "Tower 2, Suite 4",
        purpose: "Meeting",
        expectedDate: "2026-10-11",
        expectedTime: "14:00",
        plate: "kdg 221q",
      },
    });
    expect(lucy).toMatchObject({ status: "expected", plate: "KDG221Q", retainUntil: "2027-01-09" });
    expect(lucy.passCode).toMatch(/^\d{6}$/);
    expect(lucy.delivery).toMatch(/not sent/);
    const tom = await gate.registerVisitor({
      params: P(),
      body: {
        kind: "walk_in",
        siteId: ops.siteId,
        name: "Tom Mbugua",
        host: "Westgate Properties",
        purpose: "Interview",
        idType: "national_id",
        idLast4: "4417",
      },
    });
    expect(tom).toMatchObject({ status: "awaiting_host", idLast4: "4417" });
    const at = eat("2026-10-11", "14:05");
    await refused(gate.visitorAction({ params: { orgId, visitorId: tom.id }, body: { action: "check_in", at } }), 409);
    await gate.visitorAction({ params: { orgId, visitorId: tom.id }, body: { action: "host_approved", at } });
    const inTom = await gate.visitorAction({ params: { orgId, visitorId: tom.id }, body: { action: "check_in", at } });
    expect(inTom.status).toBe("on_site");
    await gate.visitorAction({ params: { orgId, visitorId: lucy.id }, body: { action: "check_in", at } });
    const out = await gate.visitorAction({
      params: { orgId, visitorId: tom.id },
      body: { action: "check_out", at: eat("2026-10-11", "15:00") },
    });
    expect(out).toMatchObject({ status: "departed", checkedOutAt: expect.any(String) });
    const hit = await refused(
      gate.registerVisitor({
        params: P(),
        body: {
          kind: "walk_in",
          siteId: ops.siteId,
          name: "J. Ndegwa",
          host: "Unit C-03",
          purpose: "Delivery",
          idType: "passport",
          idLast4: "A123",
          plate: "kdb409l",
        },
      }),
      409,
    );
    expect(hit.message).toMatch(/On the watchlist: KDB409L/);
    const wl = await gate.listWatchlist({ params: P() });
    expect(wl.entries[0]).toMatchObject({ value: "KDB409L", hits: 1, active: true });
    const onsite = await gate.listVisitors({ params: P(), query: { view: "onsite" } });
    expect(onsite.visitors.map((v) => v.name)).toEqual(["Lucy Wambui"]);
    // after the retention date personal data is removed, the visit stays counted
    S.setToday("2027-02-01");
    try {
      await gate.visitorAction({
        params: { orgId, visitorId: lucy.id },
        body: { action: "check_out", at: eat("2026-10-11", "16:00") },
      });
      expect(await gate.purgeVisitors({ params: P() })).toEqual({ purged: 2 });
    } finally {
      S.setToday("2026-10-11");
    }
    const log = await gate.listVisitors({ params: P(), query: { view: "log" } });
    expect(log.visitors.map((v) => [v.name, v.purged, v.idLast4])).toEqual([
      ["(removed)", true, null],
      ["(removed)", true, null],
    ]);
  });

  it("access control: groups with windows, one active credential per kind, replace lost, rule checks logged, no unlock", async () => {
    const ax = st.access_administrator.api.security;
    const door = await ax.createDoor({
      params: P(),
      body: { siteId: ops.siteId, code: "D-WST-01", name: "Gate A turnstile", zone: "Perimeter" },
    });
    expect(door.reader).toEqual({ adapter: "sandbox", connected: false, status: "Not connected — test adapter" });
    const g = await ax.saveAccessGroup({
      params: P(),
      body: { name: "Westlands day guards", doorIds: [door.id], from: "06:00", to: "18:00" },
    });
    const card = await ax.issueCredential({
      params: P(),
      body: { guardId: ops.guards.A, kind: "card", groupIds: [g.id], validFrom: "2026-10-01", validTo: "2027-12-31" },
    });
    expect(card).toMatchObject({ holderName: "Amina Hassan", state: "active", outlastsLicence: true });
    expect(card.enrolment).toMatch(/Not enrolled/);
    await refused(
      ax.issueCredential({
        params: P(),
        body: { guardId: ops.guards.A, kind: "card", groupIds: [g.id], validFrom: "2026-10-01", validTo: "2026-12-31" },
      }),
      409,
    );
    const day = await ax.checkAccess({
      params: P(),
      body: { credentialId: card.id, doorId: door.id, at: eat("2026-10-12", "10:00") },
    });
    expect(day).toMatchObject({ allowed: true, source: "PALTAS rule check — not a door event" });
    const night = await ax.checkAccess({
      params: P(),
      body: { credentialId: card.id, doorId: door.id, at: eat("2026-10-12", "21:00") },
    });
    expect(night).toMatchObject({ allowed: false, reason: expect.stringMatching(/Outside the schedule/) });
    const afterLicence = await ax.checkAccess({
      params: P(),
      body: { credentialId: card.id, doorId: door.id, at: eat("2027-07-05", "10:00") },
    });
    expect(afterLicence.reason).toBe("Holder's guard licence has expired");
    const r = await ax.changeCredential({
      params: { orgId, credentialId: card.id },
      body: { action: "replace", reason: "Card reported lost" },
    });
    expect(r.credential).toMatchObject({ status: "revoked", replacedBy: r.replacement!.id });
    expect(r.replacement).toMatchObject({ status: "active", groupIds: [g.id], validFrom: "2026-10-11" });
    const old = await ax.checkAccess({
      params: P(),
      body: { credentialId: card.id, doorId: door.id, at: eat("2026-10-12", "10:00") },
    });
    expect(old).toMatchObject({ allowed: false, reason: "Credential is revoked" });
    const unlock = await ax.remoteUnlock({
      params: { orgId, doorId: door.id },
      body: { reason: "Delivery stuck at the gate" },
    });
    expect(unlock.done).toBe(false);
    const overview = await st.operations_manager.api.security.accessOverview({ params: P() });
    expect(overview.controller.connected).toBe(false);
    expect(overview.decisions).toHaveLength(4);
    expect(overview.groups[0]!.credentials).toBe(1);
  });

  it("equipment: one holder at a time, returned or recorded lost", async () => {
    const om = st.operations_manager.api.security;
    const radio = await om.createEquipment({ params: P(), body: { code: "R-118", kind: "Radio" } });
    await om.issueEquipment({ params: { orgId, equipmentId: radio.id }, body: { guardId: ops.guards.A } });
    await refused(
      om.issueEquipment({ params: { orgId, equipmentId: radio.id }, body: { guardId: ops.guards.B } }),
      409,
    );
    const guard = (await om.listGuards({ params: P(), query: {} })).guards.find((x) => x.id === ops.guards.A)!;
    expect(guard.equipment).toEqual([{ equipmentId: radio.id, code: "R-118", kind: "Radio" }]);
    await om.returnEquipment({ params: { orgId, equipmentId: radio.id }, body: { condition: "good" } });
    await om.issueEquipment({ params: { orgId, equipmentId: radio.id }, body: { guardId: ops.guards.B } });
    const lost = await om.returnEquipment({
      params: { orgId, equipmentId: radio.id },
      body: { condition: "lost", note: "Lost on patrol" },
    });
    expect(lost).toMatchObject({ status: "lost", holderGuardId: null });
    expect(lost.history.map((h) => [h.guardId, h.condition])).toEqual([
      [ops.guards.B, "lost"],
      [ops.guards.A, "good"],
    ]);
  });

  it("licence and training expiry alerts", async () => {
    const om = st.operations_manager.api.security;
    const g = await om.createGuard({
      params: P(),
      body: { name: "David Mutua", grade: "Guard", licenceNo: "PSRA-778", licenceExpiry: "2026-10-25", vetting: "due" },
    });
    await om.addTraining({
      params: { orgId, guardId: ops.guards.B },
      body: { course: "First aid", validTo: "2026-10-20" },
    });
    const al = await st.supervisor.api.security.expiryAlerts({ params: P() });
    expect(al.alerts.map((a) => [a.guardName, a.kind, a.daysLeft])).toEqual([
      ["Peter Kamau", "training", 9],
      ["David Mutua", "licence", 14],
    ]);
    const lic = await om.listGuards({ params: P(), query: { filter: "licence" } });
    expect(lic.guards.map((x) => x.id)).toEqual([g.id]);
    const [shift] = (
      await om.createShifts({
        params: P(),
        body: {
          postId: ops.gatePostId,
          shifts: [{ startsAt: eat("2026-10-26", "06:00"), endsAt: eat("2026-10-26", "18:00") }],
        },
      })
    ).shifts;
    await om.updateGuard({ params: { orgId, guardId: g.id }, body: { vetting: "cleared" } });
    const exp = await refused(om.assignShift({ params: { orgId, shiftId: shift!.id }, body: { guardId: g.id } }), 409);
    expect(exp.message).toMatch(/licence expires on 2026-10-25/);
    const dash = await st.supervisor.api.security.dashboard({ params: P() });
    expect(dash.alerts.filter((a) => a.kind === "licence" || a.kind === "training")).toHaveLength(2);
    expect(dash.activeAlarms).toBe(2); // the no-show and the panic
    expect(dash.openIncidents).toBe(1);
  });

  it("messages and integrations are recorded, never delivered", async () => {
    const m = await st.control_room_operator.api.security.sendMessage({
      params: P(),
      body: { to: { guardId: ops.guards.A }, text: "Report to the control room after your round" },
    });
    expect(m).toEqual({ recipients: 1, delivery: "Recorded — not sent (no messaging provider connected)" });
    const ints = await st.auditor.api.security.integrations({ params: P() });
    for (const s of Object.values(ints)) expect(s.connected).toBe(false);
  });
});
