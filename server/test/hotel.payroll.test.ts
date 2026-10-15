// Payroll inputs, tips and service charge, labour planning: pay is seen only by the payroll officer (every other
// role sees department totals, never a salary); a pay run is approved by someone other than its preparer (the
// database refuses it too) and posts gross pay by department; tips and service charge are shared by points to the
// minor unit; shifts never overlap for one person and the plan compares hours needed with hours scheduled.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { extHotel, type ExtHotel } from "./support/hotel-ext.js";
import { refused, type Person } from "./support/test-server.js";

describe("hotel payroll, tips and labour", () => {
  let X: ExtHotel;
  const api = (p: Person) => p.api.hotel;
  const staff = {} as Record<"achieng" | "brian" | "cate", string>;
  let run: string;

  beforeAll(async () => {
    X = await extHotel("Payroll");
    await X.inHouse("Kofi Mensah", "101");
  });
  afterAll(() => X.S.close());

  it("only the payroll officer keeps the staff pay register", async () => {
    const { st, P } = X;
    const po = api(st.payroll_officer);
    staff.achieng = (
      await po.saveStaffPay({
        params: P,
        body: {
          userId: st.housekeeping_attendant.userId,
          name: "Achieng Otieno",
          department: "rooms",
          basis: "monthly",
          monthlyMinor: 4_000_000,
          servicePoints: 2,
        },
      })
    ).id;
    staff.brian = (
      await po.saveStaffPay({
        params: P,
        body: { name: "Brian Kip", department: "fnb", basis: "hourly", hourlyMinor: 50_000, servicePoints: 3 },
      })
    ).id;
    staff.cate = (
      await po.saveStaffPay({
        params: P,
        body: { name: "Cate Njeri", department: "admin", basis: "monthly", monthlyMinor: 6_000_000, servicePoints: 0 },
      })
    ).id;
    await refused(po.saveStaffPay({ params: P, body: { name: "No pay", department: "rooms", basis: "hourly" } }), 400);
    for (const who of [st.general_manager, st.financial_controller, st.front_office_manager, st.receptionist])
      await refused(api(who).listStaffPay({ params: P }), 403);
    await refused(
      api(st.general_manager).saveStaffPay({
        params: P,
        body: { name: "Brian Kip", department: "fnb", basis: "hourly", hourlyMinor: 90_000 },
      }),
      403,
    );
    const list = await po.listStaffPay({ params: P });
    expect(list.staff.map((s) => [s.name, s.department, s.monthlyMinor, s.hourlyMinor])).toEqual([
      ["Cate Njeri", "admin", 6_000_000, 0],
      ["Brian Kip", "fnb", 0, 50_000],
      ["Achieng Otieno", "rooms", 4_000_000, 0],
    ]);
    // the audit trail names the record, never the amount
    const audit = await X.S.sql(
      "SELECT detail, after FROM audit_log WHERE org_id = $1 AND action = 'Staff pay record saved'",
      [X.orgId],
    );
    expect(JSON.stringify(audit)).not.toMatch(/4000000|50000|6000000/);
  });

  it("planners schedule shifts by name and department (no pay); one person never has overlapping shifts", async () => {
    const { st, P } = X;
    const sup = api(st.housekeeping_supervisor);
    const names = await sup.labourStaff({ params: P });
    expect(names.staff).toEqual([
      { id: staff.cate, name: "Cate Njeri", department: "admin" },
      { id: staff.brian, name: "Brian Kip", department: "fnb" },
      { id: staff.achieng, name: "Achieng Otieno", department: "rooms" },
    ]);
    await refused(api(st.receptionist).labourStaff({ params: P }), 403);
    await sup.setLabourStandards({
      params: P,
      body: {
        standards: [
          { department: "rooms", basis: "per_occupied_room", minutesPerUnit: 30 },
          { department: "fnb", basis: "fixed_per_day", minutesPerUnit: 480 },
        ],
      },
    });
    await refused(
      sup.setLabourStandards({
        params: P,
        body: {
          standards: [
            { department: "rooms", basis: "per_occupied_room", minutesPerUnit: 30 },
            { department: "rooms", basis: "per_occupied_room", minutesPerUnit: 40 },
          ],
        },
      }),
      400,
    );
    const s = await sup.scheduleShifts({
      params: P,
      body: {
        shifts: [
          { staffId: staff.brian, date: "2026-10-11", start: "07:00", end: "17:00" },
          { staffId: staff.brian, date: "2026-10-12", start: "22:00", end: "06:00" },
          { staffId: staff.achieng, date: "2026-10-11", start: "08:00", end: "16:00" },
        ],
      },
    });
    expect(s.shifts.map((x) => [x.name, x.date, x.minutes])).toEqual([
      ["Brian Kip", "2026-10-11", 600],
      ["Achieng Otieno", "2026-10-11", 480],
      ["Brian Kip", "2026-10-12", 480],
    ]);
    expect(Object.keys(s.shifts[0]!)).not.toContain("hourlyMinor");
    await expect(
      sup.scheduleShifts({
        params: P,
        body: { shifts: [{ staffId: staff.brian, date: "2026-10-13", start: "05:00", end: "09:00" }] },
      }),
    ).rejects.toThrow(/already has a shift overlapping/);
    await expect(
      X.S.sql(
        "UPDATE hotel_staff_shifts SET starts_at = '2026-10-11 16:00' WHERE staff_id = $1 AND date = '2026-10-12'",
        [staff.brian],
      ),
    ).rejects.toThrow(/hotel_shift_no_overlap/);
    const rota = await api(st.receptionist).listStaffShifts({
      params: P,
      query: { from: "2026-10-12", to: "2026-10-12" },
    });
    expect(rota.shifts.map((x) => [x.name, x.start, x.end])).toEqual([["Brian Kip", "22:00", "06:00"]]);
    const plan = await api(st.general_manager).labourPlan({
      params: P,
      query: { from: "2026-10-11", to: "2026-10-11" },
    });
    const day = plan.days[0]!;
    expect(day.occupiedRooms).toBe(1);
    expect(day.departments.filter((x) => x.requiredMinutes || x.scheduledMinutes)).toEqual([
      { department: "rooms", requiredMinutes: 30, scheduledMinutes: 480, gapMinutes: 450 },
      { department: "fnb", requiredMinutes: 480, scheduledMinutes: 600, gapMinutes: 120 },
    ]);
    expect(plan.method).toMatch(/^Rules:/);
  });

  it("a pay run: hours from the schedule with overtime, approved by someone else, posted by department", async () => {
    const { st, P } = X;
    const prepared = await api(st.payroll_officer).preparePayRun({
      params: P,
      body: { period: "2026-10", inputs: [{ staffId: staff.cate, allowancesMinor: 200_000 }] },
    });
    run = prepared.id;
    // Brian: 16 regular hours × 50,000 + 2 overtime hours × 50,000 × 1.5
    expect(prepared.lines!.map((l) => [l.name, l.regularHours, l.overtimeHours, l.grossMinor])).toEqual([
      ["Cate Njeri", 0, 0, 6_200_000],
      ["Brian Kip", 16, 2, 950_000],
      ["Achieng Otieno", 8, 0, 4_000_000],
    ]);
    expect([prepared.number, prepared.grossMinor, prepared.statutory.connected]).toEqual([
      "PAY-00001",
      11_150_000,
      false,
    ]);
    // the approver sees department totals, never a salary
    const fc = (await api(st.financial_controller).listPayRuns({ params: P })).runs[0]!;
    expect([fc.lines, fc.byDepartment]).toEqual([
      null,
      { rooms: 4_000_000, fnb: 950_000, spa: 0, other: 0, admin: 6_200_000 },
    ]);
    await refused(api(st.payroll_officer).approvePayRun({ params: { ...P, runId: run } }), 403);
    await refused(api(st.front_office_manager).listPayRuns({ params: P }), 403);
    await expect(
      X.S.sql("UPDATE hotel_pay_runs SET approved_by = prepared_by, status = 'approved' WHERE id = $1", [run]),
    ).rejects.toThrow(/hotel_pay_run_second_person/);
    const ok = await api(st.financial_controller).approvePayRun({ params: { ...P, runId: run } });
    expect([ok.status, ok.approvedBy, ok.lines]).toEqual(["approved", st.financial_controller.userId, null]);
    expect(await Promise.all(["5150", "5250", "5950", "2200"].map((c) => X.ledger(c)))).toEqual([
      4_000_000, 950_000, 6_200_000, -11_150_000,
    ]);
    await refused(api(st.general_manager).approvePayRun({ params: { ...P, runId: run } }), 409);
    await refused(api(st.payroll_officer).preparePayRun({ params: P, body: { period: "2026-10" } }), 409);
    const plan = await api(st.general_manager).labourPlan({
      params: P,
      query: { from: "2026-10-01", to: "2026-10-31" },
    });
    expect(plan.labourCostMinor).toBe(11_150_000);
  });

  it("tips and service charge are shared by points to the minor unit; individual shares only for payroll", async () => {
    const { st, P } = X;
    const steak = await api(st.general_manager).saveMenuItem({
      params: { ...P, outletId: X.H.outlets.restaurant },
      body: { code: "STEAK", name: "Sirloin steak", category: "Mains", priceMinor: 150_000 },
    });
    const o = await api(st.outlet_staff).createPosOrder({
      params: { ...P, outletId: X.H.outlets.restaurant },
      body: { lines: [{ menuItemId: steak.id, quantity: 1 }] },
    });
    await api(st.outlet_staff).settlePosOrder({
      params: { ...P, orderId: o.id },
      body: { payments: [{ method: "card", amountMinor: 191_400, reference: "CARD-1", tipMinor: 10_001 }] },
    });
    await refused(api(st.payroll_officer).distribute({ params: P, body: { kind: "tips", upTo: "2026-12-31" } }), 400);
    await refused(api(st.general_manager).distribute({ params: P, body: { kind: "tips", upTo: "2026-10-11" } }), 403);
    const tips = await api(st.payroll_officer).distribute({ params: P, body: { kind: "tips", upTo: "2026-10-11" } });
    expect(tips.poolMinor).toBe(10_001);
    // 2 : 3 points (Cate has none) → 4,000.4 and 6,000.6 → the remainder to the larger fraction
    expect(tips.lines!.map((l) => [l.name, l.points, l.amountMinor])).toEqual([
      ["Achieng Otieno", 2, 4_000],
      ["Brian Kip", 3, 6_001],
    ]);
    expect(await X.ledger("2130")).toBe(0);
    const sc = await api(st.payroll_officer).distribute({
      params: P,
      body: { kind: "service_charge", upTo: "2026-10-11", departments: ["fnb"] },
    });
    expect([sc.poolMinor, sc.lines!.map((l) => [l.name, l.amountMinor])]).toEqual([15_000, [["Brian Kip", 15_000]]]);
    await refused(
      api(st.payroll_officer).distribute({ params: P, body: { kind: "service_charge", upTo: "2026-10-11" } }),
      409,
    );
    expect(await X.ledger("2200")).toBe(-11_150_000 - 10_001 - 15_000);
    const gm = await api(st.general_manager).listDistributions({ params: P });
    expect(gm.distributions.map((x) => [x.kind, x.poolMinor, x.lines])).toEqual([
      ["tips", 10_001, null],
      ["service_charge", 15_000, null],
    ]);
  });

  it("another organisation cannot see this hotel's pay runs", async () => {
    const other = await X.S.newOrg({ name: "Rival Hotels", product: "hotel", plan: "HOTEL-PRO", trial: false });
    await refused(other.admin.api.hotel.listPayRuns({ params: X.P }), 404);
    await refused(other.admin.api.hotel.approvePayRun({ params: { ...X.P, runId: run } }), 404);
  });
});
