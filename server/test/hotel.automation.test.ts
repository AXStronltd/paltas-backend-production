// Automation: the night audit at the hotel's set time, run by the PALTAS scheduler (job "hotel.night_audit"),
// refused with its reasons while a cashier shift is open or a void awaits approval and then closing the day;
// pre-arrival messages and preventive maintenance tickets recorded once.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { guest } from "./support/hotel-fixture.js";
import { extHotel, type ExtHotel } from "./support/hotel-ext.js";
import { refused, type Person } from "./support/test-server.js";

describe("hotel automation", () => {
  let X: ExtHotel;
  const api = (p: Person) => p.api.hotel;
  let kofi: { reservationId: string; stayId: string; folioId: string };
  let ned: string;

  /** Let the scheduler fire the hotel's job at its next scheduled moment; returns the run's summary. */
  async function fire(): Promise<{ status: string; summary: string | null }> {
    // only the hotel's schedule runs in this test database (the platform's own jobs are paused here)
    await X.S.sql("UPDATE sched_jobs SET status = 'paused', paused_reason = 'hotel test' WHERE org_id IS NULL");
    const [job] = await X.S.sql(
      "SELECT id, next_run_at FROM sched_jobs WHERE key = 'hotel.night_audit' AND target_id = $1",
      [X.P.propertyId],
    );
    const at = new Date(new Date(job.next_run_at).getTime() + 60_000);
    expect(await X.S.app.core.scheduler.runOnce("test-worker", at)).toBe(true);
    const [run] = await X.S.sql(
      "SELECT status, summary FROM sched_runs WHERE job_id = $1 ORDER BY created_at DESC LIMIT 1",
      [job.id],
    );
    return run;
  }

  beforeAll(async () => {
    X = await extHotel("Auto");
    kofi = await X.inHouse("Kofi Mensah", "101");
    const n = await api(X.st.receptionist).createReservation({
      params: X.P,
      body: {
        guest: guest("Ned Noshow"),
        arrival: "2026-10-11",
        departure: "2026-10-12",
        rooms: [{ roomTypeId: X.H.types.STD, ratePlanId: X.H.plans.BAR }],
      },
    });
    ned = n.id;
  });
  afterAll(() => X.S.close());

  it("turning the automatic night audit on registers the hotel's schedule with the PALTAS scheduler", async () => {
    const { st, P } = X;
    await refused(
      api(st.receptionist).updateExtensionSettings({
        params: P,
        body: { autoNightAudit: { enabled: true, time: "02:00", processNoShows: true } },
      }),
      403,
    );
    const set = await api(st.general_manager).updateExtensionSettings({
      params: P,
      body: { autoNightAudit: { enabled: true, time: "02:00", processNoShows: true }, preArrivalDays: 2 },
    });
    expect(set.autoNightAudit).toEqual({ enabled: true, time: "02:00", processNoShows: true });
    const read = await api(st.receptionist).getExtensionSettings({ params: P });
    expect([read.autoNightAudit.enabled, read.preArrivalDays]).toEqual([true, 2]);
    const jobs = await X.S.sql("SELECT key, org_id, cron, timezone, status FROM sched_jobs WHERE target_id = $1", [
      P.propertyId,
    ]);
    expect(jobs).toEqual([
      { key: "hotel.night_audit", org_id: X.orgId, cron: "0 2 * * *", timezone: "Africa/Nairobi", status: "active" },
    ]);
  });

  it("the scheduled audit is refused with every reason (open shift, unapproved void) and the managers are told", async () => {
    const { st, P } = X;
    await api(st.receptionist).openShift({ params: P, body: { floatMinor: 10_000 } });
    const f = await api(st.receptionist).postCharge({
      params: { ...P, folioId: kofi.folioId },
      body: { department: "other", description: "Wrong laundry", amountMinor: 30_000 },
    });
    await api(st.receptionist).voidLine({
      params: { ...P, folioId: kofi.folioId, lineId: f.lines.at(-1)!.id },
      body: { reason: "Posted to the wrong guest" },
    });
    const run = await fire();
    expect(run.status).toBe("succeeded");
    expect(run.summary).toMatch(/night audit for 2026-10-11 blocked/);
    expect(run.summary).toMatch(/cashier shift/);
    expect(run.summary).toMatch(/await approval/);
    expect((await api(st.front_office_manager).getProperty({ params: P })).businessDate).toBe("2026-10-11");
    const blocked = await X.S.sql("SELECT status, run_by FROM hotel_night_audits WHERE property_id = $1", [
      P.propertyId,
    ]);
    expect(blocked).toEqual([{ status: "blocked", run_by: null }]);
    const told = await X.S.sql("SELECT subject, body FROM hotel_messages WHERE template = 'audit_blocked'");
    expect(told).toHaveLength(3);
    expect(told[0].body).toMatch(
      /^The automatic night audit of 2026-10-11 at Auto Hotel could not close the day: .*cashier shift/,
    );
  });

  it("once nothing blocks it, the scheduled audit closes the day, processes no-shows and records the report for managers", async () => {
    const { st, P } = X;
    await X.closeShifts();
    const voided = (await api(st.receptionist).getFolio({ params: { ...P, folioId: kofi.folioId } })).lines.find(
      (l) => l.kind === "void",
    )!;
    await api(st.front_office_manager).approveVoid({
      params: { ...P, folioId: kofi.folioId, lineId: voided.voidsLineId! },
    });
    // the database refuses a void approved by the person who made it
    await expect(
      X.S.sql("UPDATE hotel_folio_lines SET void_approved_by = created_by WHERE id = $1", [voided.id]),
    ).rejects.toThrow(/hotel_void_second_person/);
    // an arrival in two days gets its pre-arrival message from the same run
    const soon = await api(st.receptionist).createReservation({
      params: P,
      body: {
        guest: { name: "Sara Soon", email: "sara@guest.test" },
        arrival: "2026-10-13",
        departure: "2026-10-15",
        rooms: [{ roomTypeId: X.H.types.STD, ratePlanId: X.H.plans.BAR }],
      },
    });
    const run = await fire();
    expect(run.summary).toMatch(/night audit for 2026-10-11 completed; business date now 2026-10-12/);
    expect(run.summary).toMatch(/1 pre-arrival message/);
    expect((await api(st.front_office_manager).getProperty({ params: P })).businessDate).toBe("2026-10-12");
    const report = await api(st.general_manager).getDailyReport({ params: { ...P, date: "2026-10-11" } });
    expect(report.distribution).toBe(
      "Recorded in the outbox for 3 manager(s) — not e-mailed (no e-mail provider connected)",
    );
    expect(report.noShows).toBe(1);
    expect((await api(st.receptionist).getReservation({ params: { ...P, reservationId: ned } })).status).toBe(
      "no_show",
    );
    const ia = await api(st.income_auditor).getIncomeAudit({ params: { ...P, date: "2026-10-11" } });
    expect(ia.findings).toEqual([]);
    const pre = await api(st.receptionist).listMessages({ params: P, query: { reservationId: soon.id } });
    expect(pre.messages.map((m) => m.template)).toEqual(["confirmation", "pre_arrival"]);
    // the same day's automation again records nothing twice
    const again = await api(st.receptionist).runAutomation({ params: P });
    expect([again.preArrival, again.preventiveTickets]).toEqual([0, 0]);
    expect(again.messaging.connected).toBe(false);
    const audits = await X.S.sql(
      "SELECT actor_role FROM audit_log WHERE action = 'Night audit completed' AND org_id = $1",
      [X.orgId],
    );
    expect(audits).toEqual([{ actor_role: "system:scheduler" }]);
  });

  it("preventive maintenance plans raise one ticket per due date", async () => {
    const { st, P } = X;
    const plan = await api(st.technician).createMaintenancePlan({
      params: P,
      body: {
        title: "Clean filters and check gas",
        assetLabel: "Air conditioning",
        roomId: X.H.rooms["101"]!.id,
        everyDays: 30,
        firstDue: "2026-10-12",
      },
    });
    await refused(
      api(st.receptionist).createMaintenancePlan({
        params: P,
        body: { title: "Not mine", assetLabel: "Lift", everyDays: 7, firstDue: "2026-10-12" },
      }),
      403,
    );
    const r = await api(st.receptionist).runAutomation({ params: P });
    expect(r.preventiveTickets).toBe(1);
    expect((await api(st.receptionist).runAutomation({ params: P })).preventiveTickets).toBe(0);
    const t = (await api(st.technician).listMaintenance({ params: P, query: { status: "open" } })).tickets;
    expect(t.map((x) => [x.kind, x.title, x.dueDate])).toEqual([
      ["preventive", "Air conditioning: Clean filters and check gas", "2026-10-12"],
    ]);
    const plans = await api(st.technician).listMaintenancePlans({ params: P });
    expect(plans.plans.find((p) => p.id === plan.id)!.nextDue).toBe("2026-11-11");
  });

  it("with the automatic audit turned off the scheduled job does nothing", async () => {
    const { st, P } = X;
    await api(st.general_manager).updateExtensionSettings({
      params: P,
      body: { autoNightAudit: { enabled: false, time: "02:00", processNoShows: true } },
    });
    const run = await fire();
    expect(run.summary).toMatch(/Automatic night audit is off/);
    expect((await api(st.front_office_manager).getProperty({ params: P })).businessDate).toBe("2026-10-12");
  });
});
