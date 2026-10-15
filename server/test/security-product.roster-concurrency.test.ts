// No double-booking a guard, under concurrency: two people assigning the same guard to overlapping shifts at the
// same moment — exactly one wins, every time; the same shift offered to two guards at once — exactly one gets it;
// and the database refuses an overlapping booking even when the application is bypassed.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  buildOps,
  eat,
  securityOrg,
  startSecurityServer,
  type Staff,
  type TestOps,
} from "./support/security-fixture.js";
import { type TestServer } from "./support/test-server.js";

describe("security roster — no double-booking under concurrency", () => {
  let S: TestServer;
  let orgId: string;
  let st: Staff;
  let ops: TestOps;
  const P = () => ({ orgId });

  beforeAll(async () => {
    S = await startSecurityServer();
    const o = await securityOrg(S, "Linda Security");
    orgId = o.orgId;
    st = o.staff;
    ops = await buildOps(orgId, st);
  });
  afterAll(() => S.close());

  const create = async (postId: string, start: string, end: string) =>
    (
      await st.operations_manager.api.security.createShifts({
        params: P(),
        body: { postId, shifts: [{ startsAt: start, endsAt: end }] },
      })
    ).shifts[0]!.id;

  it("two managers assign one guard to overlapping shifts at once: exactly one succeeds, every round", async () => {
    for (let day = 1; day <= 8; day++) {
      const date = `2026-11-${String(day * 3).padStart(2, "0")}`;
      const s1 = await create(ops.gatePostId, eat(date, "06:00"), eat(date, "18:00"));
      const s2 = await create(ops.patrolPostId, eat(date, "12:00"), eat(date, "20:00"));
      const results = await Promise.allSettled([
        st.operations_manager.api.security.assignShift({
          params: { orgId, shiftId: s1 },
          body: { guardId: ops.guards.A },
        }),
        st.supervisor.api.security.assignShift({ params: { orgId, shiftId: s2 }, body: { guardId: ops.guards.A } }),
      ]);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      const lost = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
      expect(lost.reason).toMatchObject({ status: 409, code: "CONFLICT" });
      expect(String(lost.reason.message)).toMatch(/already booked on an overlapping shift/);
    }
    // the guard's bookings never overlap
    const overlaps = await S.sql(
      `SELECT count(*)::int AS n FROM sec_shifts a JOIN sec_shifts b ON a.guard_id = b.guard_id AND a.id < b.id
       WHERE a.org_id = $1 AND a.status <> 'cancelled' AND b.status <> 'cancelled'
         AND tstzrange(a.starts_at, a.ends_at) && tstzrange(b.starts_at, b.ends_at)`,
      [orgId],
    );
    expect(overlaps[0].n).toBe(0);
    const booked = await S.sql("SELECT count(*)::int AS n FROM sec_shifts WHERE org_id = $1 AND guard_id = $2", [
      orgId,
      ops.guards.A,
    ]);
    expect(booked[0].n).toBe(8);
  });

  it("one shift assigned to two guards at once: exactly one gets it", async () => {
    const s = await create(ops.gatePostId, eat("2026-12-01", "06:00"), eat("2026-12-01", "18:00"));
    const results = await Promise.allSettled([
      st.operations_manager.api.security.assignShift({
        params: { orgId, shiftId: s },
        body: { guardId: ops.guards.A },
      }),
      st.supervisor.api.security.assignShift({ params: { orgId, shiftId: s }, body: { guardId: ops.guards.B } }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const row = await S.sql<{ guard_id: string; status: string }>(
      "SELECT guard_id, status FROM sec_shifts WHERE id = $1",
      [s],
    );
    const winner = (results.find((r) => r.status === "fulfilled") as PromiseFulfilledResult<{ guardId: string }>).value
      .guardId;
    expect(row[0]).toEqual({ guard_id: winner, status: "assigned" });
  });

  it("the database refuses an overlapping booking even when the application is bypassed", async () => {
    const s = await create(ops.gatePostId, eat("2026-12-05", "06:00"), eat("2026-12-05", "18:00"));
    await st.operations_manager.api.security.assignShift({
      params: { orgId, shiftId: s },
      body: { guardId: ops.guards.B },
    });
    const other = await create(ops.patrolPostId, eat("2026-12-05", "17:00"), eat("2026-12-06", "05:00"));
    await expect(
      S.sql("UPDATE sec_shifts SET guard_id = $2, status = 'assigned' WHERE id = $1", [other, ops.guards.B]),
    ).rejects.toThrow(/sec_guard_not_double_booked/);
    // a cancelled shift no longer blocks the time
    await st.operations_manager.api.security.unassignShift({
      params: { orgId, shiftId: s },
      body: { cancel: true, reason: "Client closed for the day" },
    });
    await S.sql("UPDATE sec_shifts SET guard_id = $2, status = 'assigned' WHERE id = $1", [other, ops.guards.B]);
  });
});
