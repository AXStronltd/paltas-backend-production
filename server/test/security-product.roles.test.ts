// Security roles and separation of duties, enforced by the server (and, where cheap, by the database): each role is
// refused what it may not do, guards act only for themselves, nobody approves a timesheet they recorded or corrected
// or a payroll they prepared, nobody closes an incident they reported, and a suspended subscription keeps records
// readable but refuses changes.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  buildOps,
  eat,
  securityOrg,
  SITE_POS,
  startSecurityServer,
  type Staff,
  type TestOps,
} from "./support/security-fixture.js";
import { refused, type Person, type TestServer } from "./support/test-server.js";

describe("security roles and separation of duties", () => {
  let S: TestServer;
  let orgId: string;
  let st: Staff;
  let ops: TestOps;
  let admin: Person;
  const P = () => ({ orgId });

  beforeAll(async () => {
    S = await startSecurityServer();
    const o = await securityOrg(S, "Ngome Security");
    orgId = o.orgId;
    st = o.staff;
    admin = o.admin;
    ops = await buildOps(orgId, st);
    const v = (await st.operations_manager.api.security.getSite({ params: { orgId, siteId: ops.siteId } })).posts[0]!
      .orderVersion;
    await st.guardA.api.security.acknowledgePostOrder({
      params: { orgId, postId: ops.gatePostId },
      body: { guardId: ops.guards.A, version: v },
    });
  });
  afterAll(() => S.close());

  const shift = async (date: string, guardId: string) => {
    const om = st.operations_manager.api.security;
    const [s] = (
      await om.createShifts({
        params: P(),
        body: { postId: ops.gatePostId, shifts: [{ startsAt: eat(date, "06:00"), endsAt: eat(date, "18:00") }] },
      })
    ).shifts;
    await om.assignShift({ params: { orgId, shiftId: s!.id }, body: { guardId } });
    return s!.id;
  };

  it("each role is refused what it may not do (ROLE_NOT_ALLOWED)", async () => {
    const no = (p: Promise<unknown>) => refused(p, 403, "ROLE_NOT_ALLOWED");
    const sec = (p: Person) => p.api.security;
    const period = { period: "2026-10" };
    // guards: field work only
    await no(sec(st.guardA).listSites({ params: P() }));
    await no(
      sec(st.guardA).createShifts({
        params: P(),
        body: {
          postId: ops.gatePostId,
          shifts: [{ startsAt: eat("2026-10-20", "06:00"), endsAt: eat("2026-10-20", "18:00") }],
        },
      }),
    );
    await no(sec(st.guardA).approveTimesheets({ params: P(), body: { shiftIds: ["x"] } }));
    await no(sec(st.guardA).runBilling({ params: P(), body: period }));
    await no(
      sec(st.guardA).acknowledgeAlarm({ params: { orgId, alarmId: "x" }, body: { at: eat("2026-10-11", "10:00") } }),
    );
    // gate officers: visitors and the book only (they may list the sites to choose the desk's site)
    expect((await sec(st.gate_officer).listSites({ params: P() })).sites.length).toBeGreaterThan(0);
    await no(
      sec(st.gate_officer).raiseAlarm({
        params: P(),
        body: { siteId: ops.siteId, at: eat("2026-10-11", "10:00"), detail: "Test" },
      }),
    );
    await no(
      sec(st.gate_officer).issueCredential({
        params: P(),
        body: { holderName: "X", kind: "pin", groupIds: ["x"], validFrom: "2026-10-11", validTo: "2026-10-12" },
      }),
    );
    // client portal members: the portal only
    await no(sec(st.security_client).dashboard({ params: P() }));
    await no(sec(st.security_client).listInvoices({ params: P(), query: {} }));
    await no(sec(st.viewer).listSites({ params: P() }));
    // read-only auditor
    await no(sec(st.auditor).createSite({ params: P(), body: { name: "X", kind: "X" } }));
    await no(sec(st.auditor).runBilling({ params: P(), body: period }));
    await no(
      sec(st.auditor).closeIncident({ params: { orgId, incidentId: "x" }, body: { note: "Closing by auditor" } }),
    );
    // finance staff do not run operations; operations staff do not bill or pay
    await no(sec(st.accountant).createSite({ params: P(), body: { name: "X", kind: "X" } }));
    await no(sec(st.accountant).assignShift({ params: { orgId, shiftId: "x" }, body: { guardId: "x" } }));
    await no(sec(st.accountant).approvePayroll({ params: { orgId, period: "2026-10" } }));
    await no(
      sec(st.accountant).setPayrollRules({
        params: P(),
        body: {
          payRates: [{ grade: "G", hourlyMinor: 1, overtimePct: 150, holidayPct: 200 }],
          statutory: [],
          incomeTaxBands: [],
          personalReliefMinor: 0,
        },
      }),
    );
    await no(sec(st.operations_manager).runBilling({ params: P(), body: period }));
    await no(sec(st.operations_manager).preparePayroll({ params: P(), body: period }));
    await no(sec(st.supervisor).approveTimesheets({ params: P(), body: { shiftIds: ["x"] } }));
    await no(sec(st.supervisor).financeKpis({ params: P(), query: { from: "2026-10-01", to: "2026-10-31" } }));
    await no(
      sec(st.supervisor).createGuard({
        params: P(),
        body: { name: "X", grade: "Guard", licenceNo: "L-1", licenceExpiry: "2027-01-01", vetting: "cleared" },
      }),
    );
    await no(sec(st.control_room_operator).assignShift({ params: { orgId, shiftId: "x" }, body: { guardId: "x" } }));
    await no(
      sec(st.control_room_operator).registerVisitor({
        params: P(),
        body: {
          kind: "walk_in",
          siteId: ops.siteId,
          name: "X Y",
          host: "H",
          purpose: "Visit",
          idType: "other",
          idLast4: "1234",
        },
      }),
    );
    await no(
      sec(st.access_administrator).registerVisitor({
        params: P(),
        body: {
          kind: "walk_in",
          siteId: ops.siteId,
          name: "X Y",
          host: "H",
          purpose: "Visit",
          idType: "other",
          idLast4: "1234",
        },
      }),
    );
    await no(
      sec(st.access_administrator).createShifts({
        params: P(),
        body: {
          postId: ops.gatePostId,
          shifts: [{ startsAt: eat("2026-10-20", "06:00"), endsAt: eat("2026-10-20", "18:00") }],
        },
      }),
    );
  });

  it("guards act for themselves only; supervisors may record for any guard", async () => {
    const id = await shift("2026-10-01", ops.guards.A);
    const ev = { capturedAt: eat("2026-10-01", "06:00"), method: "gps" as const, ...SITE_POS };
    await refused(st.guardB.api.security.clockIn({ params: { orgId, shiftId: id }, body: ev }), 403, "FORBIDDEN");
    await refused(
      st.guardB.api.security.startPatrol({
        params: P(),
        body: { siteId: ops.siteId, guardId: ops.guards.A, startedAt: eat("2026-10-01", "07:00") },
      }),
      403,
      "FORBIDDEN",
    );
    const byHand = await st.supervisor.api.security.clockIn({
      params: { orgId, shiftId: id },
      body: { ...ev, method: "manual" },
    });
    expect(byHand.clockIn).toMatchObject({ method: "manual", recordedBy: st.supervisor.userId });
  });

  it("timesheets: whoever recorded or corrected the attendance cannot approve it", async () => {
    const om = st.operations_manager.api.security;
    const id = await shift("2026-10-02", ops.guards.A);
    await st.guardA.api.security.clockIn({
      params: { orgId, shiftId: id },
      body: { capturedAt: eat("2026-10-02", "06:00"), method: "gps", ...SITE_POS },
    });
    await st.guardA.api.security.clockOut({
      params: { orgId, shiftId: id },
      body: { capturedAt: eat("2026-10-02", "17:00"), method: "gps", ...SITE_POS },
    });
    await om.adjustAttendance({
      params: { orgId, shiftId: id },
      body: {
        inAt: eat("2026-10-02", "06:00"),
        outAt: eat("2026-10-02", "18:00"),
        reason: "Clock-out tapped early by mistake",
      },
    });
    await refused(om.approveTimesheets({ params: P(), body: { shiftIds: [id] } }), 403, "SEPARATION_OF_DUTIES");
    // the database refuses it too, whatever the code does
    await expect(
      S.sql(
        "UPDATE sec_shifts SET timesheet_status = 'approved', approved_by = adjusted_by, approved_at = now() WHERE id = $1",
        [id],
      ),
    ).rejects.toThrow(/sec_timesheet_second_person/);
    await expect(
      S.sql(
        "UPDATE sec_shifts SET timesheet_status = 'approved', approved_by = clocked_in_by, approved_at = now() WHERE id = $1",
        [id],
      ),
    ).rejects.toThrow(/sec_timesheet_second_person/);
    // a second operations manager, who did not touch the attendance, approves it
    const second = await S.addMember(orgId, admin.api, "operations_manager");
    const ok = await second.api.security.approveTimesheets({ params: P(), body: { shiftIds: [id] } });
    expect(ok.shifts[0]!.timesheet).toMatchObject({
      status: "approved",
      normalMinutes: 720,
      approvedBy: second.userId,
    });
  });

  it("payroll: the preparer cannot approve; the database backs it up", async () => {
    const fd = st.finance_director.api.security;
    const om = st.operations_manager.api.security;
    // an approved timesheet in November (recorded by the guard, approved by the operations manager)
    const id = await shift("2026-11-02", ops.guards.B);
    const gb = st.guardB.api.security;
    const v = (await om.getSite({ params: { orgId, siteId: ops.siteId } })).posts[0]!.orderVersion;
    await gb.acknowledgePostOrder({
      params: { orgId, postId: ops.gatePostId },
      body: { guardId: ops.guards.B, version: v },
    });
    await gb.clockIn({
      params: { orgId, shiftId: id },
      body: { capturedAt: eat("2026-11-02", "06:00"), method: "gps", ...SITE_POS },
    });
    await gb.clockOut({
      params: { orgId, shiftId: id },
      body: { capturedAt: eat("2026-11-02", "18:00"), method: "gps", ...SITE_POS },
    });
    await refused(gb.approveTimesheets({ params: P(), body: { shiftIds: [id] } }), 403, "ROLE_NOT_ALLOWED");
    await om.approveTimesheets({ params: P(), body: { shiftIds: [id] } });
    const run = await fd.preparePayroll({ params: P(), body: { period: "2026-11" } });
    expect(run.grossMinor).toBe(120_000);
    await refused(fd.approvePayroll({ params: { orgId, period: "2026-11" } }), 403, "SEPARATION_OF_DUTIES");
    await expect(
      S.sql("UPDATE sec_payroll_runs SET status = 'approved', approved_by = prepared_by WHERE id = $1", [run.id]),
    ).rejects.toThrow(/sec_payroll_second_person/);
    const journals = await S.sql(
      "SELECT count(*)::int AS n FROM journal_entries WHERE org_id = $1 AND source = 'system:security'",
      [orgId],
    );
    expect(journals[0].n).toBe(0);
  });

  it("incidents: the reporter cannot close; the database backs it up", async () => {
    const sup = st.supervisor.api.security;
    const inc = await sup.reportIncident({
      params: P(),
      body: {
        siteId: ops.siteId,
        type: "Lost key",
        severity: "low",
        description: "Store key missing at handover",
        occurredAt: eat("2026-10-03", "18:00"),
      },
    });
    await refused(
      sup.closeIncident({ params: { orgId, incidentId: inc.id }, body: { note: "Key found in drawer" } }),
      403,
      "SEPARATION_OF_DUTIES",
    );
    await expect(
      S.sql("UPDATE sec_incidents SET status = 'closed', closed_by = reported_by, closed_at = now() WHERE id = $1", [
        inc.id,
      ]),
    ).rejects.toThrow(/sec_incident_closed_by_other/);
    const closed = await st.operations_manager.api.security.closeIncident({
      params: { orgId, incidentId: inc.id },
      body: { note: "Key found in drawer" },
    });
    expect(closed.status).toBe("closed");
  });

  it("a suspended subscription keeps records readable and refuses changes", async () => {
    const staff = await S.staff();
    await staff.api.admin.setSubscriptionStatus({
      params: P(),
      body: { status: "suspended", reason: "Unpaid PALTAS invoice", product: "security" },
    });
    try {
      expect((await st.operations_manager.api.security.listSites({ params: P() })).sites).toHaveLength(1);
      await refused(
        st.operations_manager.api.security.createSite({ params: P(), body: { name: "New site", kind: "Office" } }),
        402,
        "SUBSCRIPTION_INACTIVE",
      );
      await refused(
        st.guardA.api.security.raisePanic({
          params: P(),
          body: { guardId: ops.guards.A, siteId: ops.siteId, at: eat("2026-10-11", "09:00") },
        }),
        402,
      );
    } finally {
      await staff.api.admin.setSubscriptionStatus({
        params: P(),
        body: { status: "active", reason: "Invoice paid by bank transfer", product: "security" },
      });
    }
  });
});
