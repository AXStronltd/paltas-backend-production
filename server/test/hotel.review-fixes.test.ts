// One test per finding of the hotel code review (14 October 2026), so none can return unnoticed.
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildHotel, guest, hotelOrg, startHotelServer, type Staff, type TestHotel } from "./support/hotel-fixture.js";
import { refused, type Person, type TestServer } from "./support/test-server.js";

describe("hotel review findings stay fixed", () => {
  let S: TestServer;
  let orgId: string;
  let admin: Person;
  let st: Staff;
  let A1: TestHotel;
  let A2: TestHotel;
  let orgB: string;
  let stB: Staff;
  let HB: TestHotel;
  const D1 = "2026-10-11";
  const D2 = "2026-10-12";
  const D3 = "2026-10-13";
  const api = (p: Person) => p.api.hotel;
  const PA1 = () => ({ orgId, propertyId: A1.propertyId });
  const PA2 = () => ({ orgId, propertyId: A2.propertyId });
  const PB = () => ({ orgId: orgB, propertyId: HB.propertyId });

  /** `p` books one standard room from D1 to D3 and `desk` checks the guest in; returns the stay and its guest folio. */
  async function inHouse(
    p: Person,
    desk: Person,
    P: { orgId: string; propertyId: string },
    H: TestHotel,
    room: string,
    extra: Record<string, unknown> = {},
  ) {
    const { rooms, ...rest } = extra as { rooms?: Record<string, unknown> };
    const r = await api(p).createReservation({
      params: P,
      body: {
        guest: guest(`Guest ${room} ${P.propertyId.slice(-4)}`),
        arrival: D1,
        departure: D3,
        rooms: [{ roomTypeId: H.types.STD, ratePlanId: H.plans.BAR, ...rooms }],
        ...rest,
      } as never,
    });
    const ci = await api(desk).checkIn({
      params: { ...P, stayId: r.stays[0]!.id },
      body: { roomId: H.rooms[room]!.id },
    });
    return { reservationId: r.id, stayId: ci.stay.id, folioId: ci.folio.id };
  }

  /** Wait until `n` sessions of this database wait on a row lock. */
  async function lockWaiters(c: pg.Client, n: number) {
    for (let i = 0; i < 200; i++) {
      const r = await c.query(
        "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'",
      );
      if (r.rows[0].n >= n) return;
      await new Promise((ok) => setTimeout(ok, 25));
    }
    throw new Error(`Expected ${n} session(s) waiting on a lock`);
  }

  beforeAll(async () => {
    S = await startHotelServer();
    S.setToday(D1);
    const o = await hotelOrg(S, "Review Hotels A");
    ({ orgId, admin } = o);
    st = o.staff;
    A1 = await buildHotel(orgId, st.general_manager, {
      name: "Review One",
      counts: { STD: 4, DLX: 1, STE: 1 },
      staff: st,
    });
    A2 = await buildHotel(orgId, st.general_manager, {
      name: "Review Two",
      counts: { STD: 4, DLX: 1, STE: 1 },
      staff: st,
    });
    const b = await hotelOrg(S, "Review Hotels B");
    orgB = b.orgId;
    stB = b.staff;
    HB = await buildHotel(orgB, stB.general_manager, { name: "Other Org Hotel", staff: stB });
  });
  afterAll(() => S.close());

  it("1. a member with no hotel assignment reaches no hotel (fail closed)", async () => {
    const rc = await S.addMember(orgId, admin.api, "receptionist");
    // never assigned: nothing
    expect((await api(rc).listProperties({ params: { orgId } })).properties).toEqual([]);
    await refused(api(rc).getSetup({ params: PA1() }), 404);
    // assigned to A1 only: A1 only
    const staffA1 = [st.general_manager, ...Object.values(st)].map((m) => m.userId);
    await api(admin).setPropertyStaff({ params: PA1(), body: { userIds: [...staffA1, rc.userId] } });
    expect((await api(rc).listProperties({ params: { orgId } })).properties.map((p) => p.id)).toEqual([A1.propertyId]);
    await api(rc).getSetup({ params: PA1() });
    await refused(api(rc).getSetup({ params: PA2() }), 404);
    // removed from A1: neither hotel, and no group view either
    await api(admin).setPropertyStaff({ params: PA1(), body: { userIds: staffA1 } });
    expect((await api(rc).listProperties({ params: { orgId } })).properties).toEqual([]);
    await refused(api(rc).getSetup({ params: PA1() }), 404);
    await refused(api(rc).getSetup({ params: PA2() }), 404);
    await refused(api(rc).listFolios({ params: PA2(), query: {} }), 404);
    // administrators and group owners still reach every hotel
    expect((await api(st.group_owner).listProperties({ params: { orgId } })).properties).toHaveLength(2);
  });

  let bVoid: { folioId: string; lineId: string };

  it("2. a void cannot be approved through another organisation's hotel", async () => {
    const g = await inHouse(stB.receptionist, stB.receptionist, PB(), HB, "101");
    const f = await api(stB.receptionist).postCharge({
      params: { ...PB(), folioId: g.folioId },
      body: { department: "other", description: "Parking", amountMinor: 10_000 },
    });
    bVoid = { folioId: g.folioId, lineId: f.lines.at(-1)!.id };
    await api(stB.receptionist).voidLine({ params: { ...PB(), ...bVoid }, body: { reason: "Wrong guest" } });
    // Org A's manager, through Org A's own hotel, with Org B's folio and line ids
    await refused(api(st.general_manager).approveVoid({ params: { ...PA1(), ...bVoid } }), 404);
    // and through Org B's hotel the gate already refuses them
    await refused(api(st.general_manager).approveVoid({ params: { ...PB(), ...bVoid } }), 404);
    const after = await api(stB.receptionist).getFolio({ params: { ...PB(), folioId: bVoid.folioId } });
    expect(after.lines.find((l) => l.voidsLineId === bVoid.lineId)!.voidApprovedBy).toBeNull();
  });

  it("3a. the night audit is blocked while a void of the day awaits approval", async () => {
    const check = await api(stB.front_office_manager).nightAuditCheck({ params: PB() });
    expect(check.blocks.map((b) => b.code)).toContain("UNAPPROVED_VOIDS");
    expect(check.canRun).toBe(false);
    const e = await refused(api(stB.front_office_manager).runNightAudit({ params: PB(), body: {} }), 409);
    expect(e.details.blocks.map((b: { code: string }) => b.code)).toEqual(["UNAPPROVED_VOIDS"]);
    await api(stB.front_office_manager).approveVoid({ params: { ...PB(), ...bVoid } });
    const out = await api(stB.front_office_manager).runNightAudit({ params: PB(), body: {} });
    expect([out.closedDate, out.businessDate]).toEqual([D1, D2]);
  });

  it("3b. a rate set below plan is acknowledged at income audit only by someone other than who set it", async () => {
    const rm = await S.addMember(orgId, admin.api, "revenue_manager");
    const staffA1 = [st.general_manager, ...Object.values(st)].map((m) => m.userId);
    await api(admin).setPropertyStaff({ params: PA1(), body: { userIds: [...staffA1, rm.userId] } });
    await inHouse(rm, st.receptionist, PA1(), A1, "102", { rooms: { rateOverrideMinor: 700_000 } });
    await api(st.front_office_manager).runNightAudit({ params: PA1(), body: {} });
    const ia = await api(st.income_auditor).getIncomeAudit({ params: { ...PA1(), date: D1 } });
    expect(ia.findings.map((f) => [f.code, f.amountMinor])).toEqual([["RATE_BELOW_PLAN", 300_000]]);
    // the person who set the rate later becomes an income auditor: they still cannot acknowledge their own override
    await S.sql("UPDATE memberships SET role = 'income_auditor' WHERE org_id = $1 AND user_id = $2", [
      orgId,
      rm.userId,
    ]);
    await refused(
      api(rm).signOffIncomeAudit({
        params: { ...PA1(), date: D1 },
        body: { note: "My own discount", acknowledgeFindings: true },
      }),
      403,
      "SEPARATION_OF_DUTIES",
    );
    const signed = await api(st.income_auditor).signOffIncomeAudit({
      params: { ...PA1(), date: D1 },
      body: { note: "Discount confirmed by the GM", acknowledgeFindings: true },
    });
    expect(signed.signedOffBy).toBe(st.income_auditor.userId);
  });

  it("5. a cash refund is paid out of the approver's open drawer, and the drawer balances", async () => {
    const g = await inHouse(st.receptionist, st.receptionist, PA2(), A2, "101");
    const rShift = await api(st.receptionist).openShift({ params: PA2(), body: { floatMinor: 10_000 } });
    await api(st.receptionist).recordPayment({
      params: { ...PA2(), folioId: g.folioId },
      body: { method: "cash", amountMinor: 500_000, reference: "Cash at desk" },
    });
    const refund = await api(st.receptionist).requestRefund({
      params: { ...PA2(), folioId: g.folioId },
      body: { amountMinor: 200_000, method: "cash", reason: "Overpaid in cash" },
    });
    const e = await refused(
      api(st.front_office_manager).approveRefund({ params: { ...PA2(), refundId: refund.id } }),
      409,
    );
    expect(e.message).toMatch(/cashier shift/);
    const mShift = await api(st.front_office_manager).openShift({ params: PA2(), body: { floatMinor: 300_000 } });
    expect(
      (await api(st.front_office_manager).approveRefund({ params: { ...PA2(), refundId: refund.id } })).status,
    ).toBe("approved");
    const folio = await api(st.receptionist).getFolio({ params: { ...PA2(), folioId: g.folioId } });
    expect(folio.balanceMinor).toBe(-300_000);
    // the manager's drawer: float 3,000 less the 2,000 paid out; the receptionist's: float 100 plus 5,000 taken
    const m = await api(st.front_office_manager).closeShift({
      params: { ...PA2(), shiftId: mShift.id },
      body: { countedCashMinor: 100_000 },
    });
    expect([m.takings.cash, m.expectedCashMinor, m.overShortMinor]).toEqual([-200_000, 100_000, 0]);
    const r = await api(st.receptionist).closeShift({
      params: { ...PA2(), shiftId: rShift.id },
      body: { countedCashMinor: 510_000 },
    });
    expect([r.takings.cash, r.expectedCashMinor, r.overShortMinor]).toEqual([500_000, 510_000, 0]);
  });

  it("12. a company payment cannot exceed what the company owes, even when two arrive at once", async () => {
    const g = await inHouse(st.receptionist, st.receptionist, PA2(), A2, "102", { corporateAccountId: A2.companyId });
    const company = (await api(st.receptionist).listFolios({ params: PA2(), query: { stayId: g.stayId } })).folios.find(
      (f) => f.payer === "company",
    )!;
    await api(st.receptionist).postCharge({
      params: { ...PA2(), folioId: company.id },
      body: { department: "other", description: "Meeting room", amountMinor: 100_000 },
    });
    await api(st.receptionist).checkOut({ params: { ...PA2(), stayId: g.stayId } });
    const owed = (await api(st.credit_controller).listCorporateAccounts({ params: { orgId } })).accounts.find(
      (a) => a.id === A2.companyId,
    )!.balanceMinor;
    expect(owed).toBe(116_000);
    const pay = (ref: string) =>
      api(st.credit_controller).cityLedgerPayment({
        params: { orgId, accountId: A2.companyId },
        body: { propertyId: A2.propertyId, amountMinor: owed, method: "bank_transfer", reference: ref },
      });
    // hold the company's account row while two full payments arrive; only one may land
    const c = new pg.Client({ connectionString: S.app.ctx.config.databaseUrl });
    await c.connect();
    try {
      await c.query("BEGIN");
      await c.query("SELECT 1 FROM hotel_corporate_accounts WHERE id = $1 FOR UPDATE", [A2.companyId]);
      const both = Promise.allSettled([pay("TT-1"), pay("TT-2")]);
      await lockWaiters(c, 2);
      await c.query("COMMIT");
      const out = await both;
      expect(out.map((x) => x.status).sort()).toEqual(["fulfilled", "rejected"]);
    } finally {
      await c.end();
    }
    await refused(pay("TT-3"), 400);
    const after = (await api(st.credit_controller).listCorporateAccounts({ params: { orgId } })).accounts.find(
      (a) => a.id === A2.companyId,
    )!;
    expect(after.balanceMinor).toBe(0);
  });

  it("4. a posting that waits on a night audit is dated the audit's new business date", async () => {
    const g = await inHouse(st.receptionist, st.receptionist, PA2(), A2, "103");
    // stand in for the night audit: it holds the hotel row FOR UPDATE while it rolls the business date
    const c = new pg.Client({ connectionString: S.app.ctx.config.databaseUrl });
    await c.connect();
    try {
      await c.query("BEGIN");
      await c.query("SELECT 1 FROM hotel_properties WHERE id = $1 FOR UPDATE", [A2.propertyId]);
      await c.query("UPDATE hotel_properties SET business_date = $2 WHERE id = $1", [A2.propertyId, D2]);
      const paid = api(st.receptionist).recordPayment({
        params: { ...PA2(), folioId: g.folioId },
        body: { method: "card", amountMinor: 50_000, reference: "PSP-77" },
      });
      await lockWaiters(c, 1);
      await c.query("COMMIT");
      const folio = await paid;
      const line = folio.lines.at(-1)!;
      expect([line.kind, line.date]).toEqual(["payment", D2]);
      const [j] = await S.sql<{ date: string; business_date: string }>(
        `SELECT j.date::text AS date, k.business_date::text AS business_date FROM journal_entries j
         JOIN hotel_ledger_links k ON k.journal_id = j.id WHERE j.id = $1`,
        [line.journalId],
      );
      expect(j).toEqual({ date: D2, business_date: D2 });
    } finally {
      await c.end();
    }
  });
});
