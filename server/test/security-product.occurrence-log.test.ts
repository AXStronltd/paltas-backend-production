// The occurrence book and incident log are append-only: nothing in the API edits or deletes an entry, the database
// refuses UPDATE, DELETE and TRUNCATE, a correction is a new entry that points at the one it corrects, an incident's
// facts never change once reported, and access decisions are kept as logged.
import { API } from "@paltas/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  buildOps,
  eat,
  securityOrg,
  startSecurityServer,
  type Staff,
  type TestOps,
} from "./support/security-fixture.js";
import { refused, type TestServer } from "./support/test-server.js";

describe("security occurrence book and incident log are append-only", () => {
  let S: TestServer;
  let orgId: string;
  let st: Staff;
  let ops: TestOps;
  const P = () => ({ orgId });

  beforeAll(async () => {
    S = await startSecurityServer();
    const o = await securityOrg(S, "Kinga Security");
    orgId = o.orgId;
    st = o.staff;
    ops = await buildOps(orgId, st);
  });
  afterAll(() => S.close());

  it("the API has no way to edit or delete a book entry or an incident's facts", () => {
    const sec = Object.values(API.security);
    expect(sec.filter((e) => e.method === "DELETE")).toEqual([]);
    expect(sec.filter((e) => /occurrences\/:|incidents\/:incidentId$/.test(e.path) && e.method !== "GET")).toEqual([]);
  });

  it("a correction is a new entry pointing at the original, which stays exactly as written", async () => {
    const sup = st.supervisor.api.security;
    const first = await sup.addOccurrence({
      params: P(),
      body: {
        siteId: ops.siteId,
        kind: "entry",
        text: "Vehicle KDA 512X left at 14:30",
        at: eat("2026-10-10", "15:00"),
      },
    });
    expect(first.number).toMatch(/^OB-\d{6}$/);
    await refused(
      sup.addOccurrence({
        params: P(),
        body: { siteId: ops.siteId, kind: "correction", text: "Missing pointer", at: eat("2026-10-10", "15:05") },
      }),
      400,
    );
    await refused(
      sup.addOccurrence({
        params: P(),
        body: {
          siteId: ops.siteId,
          kind: "entry",
          correctsId: first.id,
          text: "Not a correction",
          at: eat("2026-10-10", "15:05"),
        },
      }),
      400,
    );
    const fix = await st.guardA.api.security.addOccurrence({
      params: P(),
      body: {
        siteId: ops.siteId,
        kind: "correction",
        correctsId: first.id,
        text: "Correction: the vehicle left at 15:30, not 14:30",
        at: eat("2026-10-10", "15:40"),
      },
    });
    expect(fix).toMatchObject({ kind: "correction", correctsId: first.id, recordedBy: st.guardA.userId });
    const book = await st.auditor.api.security.listOccurrences({
      params: P(),
      query: { siteId: ops.siteId, from: eat("2026-10-10", "00:00"), to: eat("2026-10-11", "00:00") },
    });
    expect(book.entries).toEqual([
      { ...first, correctedBy: [fix.id] },
      { ...fix, correctedBy: [] },
    ]);
    // an entry of another site's book cannot be "corrected" from this one
    const other = await st.operations_manager.api.security.createSite({
      params: P(),
      body: { name: "Other site", kind: "Depot" },
    });
    await refused(
      sup.addOccurrence({
        params: P(),
        body: {
          siteId: other.id,
          kind: "correction",
          correctsId: first.id,
          text: "Wrong book",
          at: eat("2026-10-10", "16:00"),
        },
      }),
      400,
    );
  });

  it("the database refuses UPDATE, DELETE and TRUNCATE on the book", async () => {
    const [row] = await S.sql<{ id: string }>(
      "SELECT id FROM sec_occurrences WHERE org_id = $1 ORDER BY number LIMIT 1",
      [orgId],
    );
    await expect(S.sql("UPDATE sec_occurrences SET text = 'rewritten' WHERE id = $1", [row!.id])).rejects.toThrow(
      /append-only/,
    );
    await expect(S.sql("DELETE FROM sec_occurrences WHERE id = $1", [row!.id])).rejects.toThrow(/append-only/);
    await expect(S.sql("TRUNCATE sec_occurrences")).rejects.toThrow(/append-only/);
    const [still] = await S.sql<{ text: string }>("SELECT text FROM sec_occurrences WHERE id = $1", [row!.id]);
    expect(still!.text).toBe("Vehicle KDA 512X left at 14:30");
  });

  it("an incident's facts never change and it is never deleted; once closed it is final", async () => {
    const inc = await st.supervisor.api.security.reportIncident({
      params: P(),
      body: {
        siteId: ops.siteId,
        type: "Unauthorised visitor",
        severity: "medium",
        description: "Visitor with an expired pass found at Block C",
        occurredAt: eat("2026-10-10", "17:15"),
      },
    });
    await expect(
      S.sql("UPDATE sec_incidents SET description = 'Nothing happened' WHERE id = $1", [inc.id]),
    ).rejects.toThrow(/facts cannot be changed/);
    await expect(S.sql("UPDATE sec_incidents SET severity = 'low' WHERE id = $1", [inc.id])).rejects.toThrow(
      /facts cannot be changed/,
    );
    await expect(S.sql("DELETE FROM sec_incidents WHERE id = $1", [inc.id])).rejects.toThrow(/never deleted/);
    // a correction of the facts goes to the book and shows on the incident's timeline
    const fix = await st.supervisor.api.security.addOccurrence({
      params: P(),
      body: {
        siteId: ops.siteId,
        kind: "correction",
        correctsId: inc.timeline[0]!.id,
        text: "Correction: found at Block D, not Block C",
        at: eat("2026-10-10", "18:00"),
      },
    });
    const closed = await st.operations_manager.api.security.closeIncident({
      params: { orgId, incidentId: inc.id },
      body: { note: "Visitor escorted out; host informed" },
    });
    expect(closed.description).toBe("Visitor with an expired pass found at Block C");
    expect(closed.timeline.map((e) => e.id)).toContain(fix.id);
    expect(closed.timeline[0]!.correctedBy).toEqual([fix.id]);
    await expect(
      S.sql("UPDATE sec_incidents SET status = 'open', closed_by = NULL, closed_at = NULL WHERE id = $1", [inc.id]),
    ).rejects.toThrow(/closed incident cannot be changed/);
  });

  it("access decisions are kept as logged", async () => {
    const ax = st.access_administrator.api.security;
    const door = await ax.createDoor({
      params: P(),
      body: { siteId: ops.siteId, code: "D-1", name: "Server room", zone: "Restricted" },
    });
    const g = await ax.saveAccessGroup({
      params: P(),
      body: { name: "IT", doorIds: [door.id], from: "08:00", to: "17:00" },
    });
    const c = await ax.issueCredential({
      params: P(),
      body: {
        holderName: "Paul Otieno",
        kind: "pin",
        groupIds: [g.id],
        validFrom: "2026-10-01",
        validTo: "2026-12-31",
      },
    });
    const d = await ax.checkAccess({
      params: P(),
      body: { credentialId: c.id, doorId: door.id, at: eat("2026-10-12", "21:30") },
    });
    expect(d.allowed).toBe(false);
    await expect(S.sql("UPDATE sec_access_decisions SET allowed = true WHERE id = $1", [d.id])).rejects.toThrow(
      /append-only/,
    );
    await expect(S.sql("DELETE FROM sec_access_decisions WHERE id = $1", [d.id])).rejects.toThrow(/append-only/);
  });
});
