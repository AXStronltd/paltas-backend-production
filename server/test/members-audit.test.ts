// Members and roles, and the audit trail that nobody can change.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { refused, startServer, type Person, type TestServer } from "./support/test-server.js";

describe("members and audit", () => {
  let S: TestServer;
  let orgId: string;
  let admin: Person;

  beforeAll(async () => {
    S = await startServer();
    ({ orgId, admin } = await S.newOrg({ name: "Members Co", trial: false }));
  });
  afterAll(() => S.close());

  it("an administrator adds people with a role for the organisation's products", async () => {
    const r = await admin.api.organisations.addMember({
      params: { orgId },
      body: { email: "Grace@Members.test", name: "Grace", role: "property_manager" },
    });
    expect(r.member).toMatchObject({ email: "grace@members.test", role: "property_manager", status: "active" });
    expect(r.temporaryPassword).toHaveLength(20);
    await refused(
      admin.api.organisations.addMember({ params: { orgId }, body: { email: "grace@members.test", role: "viewer" } }),
      409,
    );
    await refused(
      admin.api.organisations.addMember({ params: { orgId }, body: { email: "x@members.test", role: "sales_agent" } }),
      400,
    ); // a Development role
    const list = await admin.api.organisations.listMembers({ params: { orgId } });
    expect(list.members.map((m) => m.email).sort()).toEqual([admin.email, "grace@members.test"].sort());
  });

  it("a suspended member is signed out at once and cannot use the organisation until restored", async () => {
    const v = await S.addMember(orgId, admin.api, "viewer");
    expect((await v.api.organisations.get({ params: { orgId } })).id).toBe(orgId);
    await admin.api.organisations.updateMember({ params: { orgId, userId: v.userId }, body: { status: "suspended" } });
    await refused(v.api.organisations.get({ params: { orgId } }), 401, "NOT_SIGNED_IN");
    const again = await S.login(v.email, v.password);
    await refused(again.api.organisations.get({ params: { orgId } }), 404); // a suspended member's organisation looks like nothing
    expect((await again.api.identity.me()).organisations).toEqual([]);
    await admin.api.organisations.updateMember({ params: { orgId, userId: v.userId }, body: { status: "active" } });
    expect((await again.api.organisations.get({ params: { orgId } })).id).toBe(orgId);
  });

  it("an existing PALTAS account joins without a new password", async () => {
    const other = await S.newOrg({ name: "Other Members Co" });
    const r = await other.admin.api.organisations.addMember({
      params: { orgId: other.orgId },
      body: { email: "grace@members.test", role: "viewer" },
    });
    expect(r.temporaryPassword).toBeNull();
  });

  it("only administrators manage members; nobody changes their own access; one administrator always remains", async () => {
    const pm = await S.addMember(orgId, admin.api, "property_manager");
    expect((await pm.api.organisations.listMembers({ params: { orgId } })).members.length).toBeGreaterThan(1);
    await refused(
      pm.api.organisations.addMember({ params: { orgId }, body: { email: "y@members.test", role: "viewer" } }),
      403,
      "ROLE_NOT_ALLOWED",
    );
    await refused(
      admin.api.organisations.updateMember({ params: { orgId, userId: admin.userId }, body: { role: "viewer" } }),
      403,
    );
    const second = await S.addMember(orgId, admin.api, "org_admin");
    const demoted = await second.api.organisations.updateMember({
      params: { orgId, userId: admin.userId },
      body: { role: "viewer" },
    });
    expect(demoted.role).toBe("viewer");
    const third = await S.addMember(orgId, second.api, "accountant");
    await second.api.organisations.updateMember({
      params: { orgId, userId: third.userId },
      body: { role: "org_admin" },
    });
    await third.api.organisations.updateMember({
      params: { orgId, userId: second.userId },
      body: { status: "suspended" },
    });
    // now `third` is the only active administrator and cannot be removed by anyone
    await refused(
      third.api.organisations.updateMember({ params: { orgId, userId: third.userId }, body: { role: "viewer" } }),
      403,
    );
    await refused(
      admin.api.organisations.updateMember({ params: { orgId, userId: third.userId }, body: { role: "viewer" } }),
      403,
      "ROLE_NOT_ALLOWED",
    );
  });

  it("the audit trail records who did what, before and after, and cannot be changed", async () => {
    const audit = await S.sql<{ action: string; before: unknown; after: unknown }>(
      "SELECT action, before, after FROM audit_log WHERE org_id = $1 ORDER BY id",
      [orgId],
    );
    expect(audit.map((a) => a.action)).toEqual(
      expect.arrayContaining(["Organisation created", "Member added", "Member access changed"]),
    );
    const change = audit.find(
      (a) => a.action === "Member access changed" && (a.before as { role: string }).role === "org_admin",
    )!;
    expect(change.after).toMatchObject({ role: "viewer" });
    const suspension = audit.find((a) => (a.after as { status?: string } | null)?.status === "suspended")!;
    expect(suspension.before).toMatchObject({ status: "active" });
    await expect(S.sql("UPDATE audit_log SET action = 'x'")).rejects.toThrow(/cannot be changed or deleted/);
    await expect(S.sql("DELETE FROM audit_log")).rejects.toThrow(/cannot be changed or deleted/);
    await expect(S.sql("TRUNCATE audit_log")).rejects.toThrow(/cannot be changed or deleted/);
  });

  it("an organisation sees only its own audit trail, newest first, page by page", async () => {
    const other = await S.newOrg({ name: "Third Members Co" });
    const mine = await other.admin.api.organisations.listAudit({ params: { orgId: other.orgId }, query: { limit: 2 } });
    expect(mine.entries.length).toBeLessThanOrEqual(2);
    const all = await other.admin.api.organisations.listAudit({
      params: { orgId: other.orgId },
      query: { limit: 500 },
    });
    expect(all.entries.every((e) => Number(e.id) > 0)).toBe(true);
    const ids = all.entries.map((e) => Number(e.id));
    expect([...ids].sort((a, b) => b - a)).toEqual(ids);
    if (mine.entries.length === 2) {
      const next = await other.admin.api.organisations.listAudit({
        params: { orgId: other.orgId },
        query: { limit: 2, before: mine.entries[1]!.id },
      });
      expect(next.entries.every((e) => Number(e.id) < Number(mine.entries[1]!.id))).toBe(true);
    }
    await refused(other.admin.api.organisations.listAudit({ params: { orgId } }), 404);
    const viewer = await S.addMember(other.orgId, other.admin.api, "viewer");
    await refused(viewer.api.organisations.listAudit({ params: { orgId: other.orgId } }), 403, "ROLE_NOT_ALLOWED");
  });
});
