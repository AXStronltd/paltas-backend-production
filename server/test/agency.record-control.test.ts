import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agencyOrg, publishedListing, SALE, startAgencyServer, type AgencyOrg } from "./support/agency-fixture.js";
import type { TestServer } from "./support/test-server.js";

describe("repeatable listing control", () => {
  let S: TestServer, A: AgencyOrg;
  beforeAll(async () => {
    S = await startAgencyServer();
    A = await agencyOrg(S);
  });
  afterAll(() => S.close());
  it("reopens and saves repeatedly, refuses stale concurrent writes and records changes without financial postings", async () => {
    const api = A.manager.api.agency,
      params = { orgId: A.orgId };
    let saved = await api.createListing({ params, body: SALE });
    for (let i = 0; i < 3; i++) {
      const reopened = await api.getListing({ params: { ...params, listingId: saved.id } });
      saved = await api.updateListing({
        params: { ...params, listingId: saved.id },
        body: { ...SALE, title: `Updated apartment ${i}`, expectedUpdatedAt: reopened.updatedAt },
      });
      expect(saved.title).toBe(`Updated apartment ${i}`);
    }
    const version = saved.updatedAt;
    const writes = await Promise.allSettled(
      ["A", "B"].map((suffix) =>
        api.updateListing({
          params: { ...params, listingId: saved.id },
          body: { ...SALE, title: `Concurrent edit ${suffix}`, expectedUpdatedAt: version },
        }),
      ),
    );
    expect(writes.filter((w) => w.status === "fulfilled")).toHaveLength(1);
    const rejected = writes.find((w) => w.status === "rejected");
    expect(rejected?.status === "rejected" && rejected.reason.status).toBe(409);
    const logs = await S.sql<{ before: { title: string }; after: { title: string } }>(
      'SELECT "before", "after" FROM audit_log WHERE org_id=$1 AND target=$2 AND action=$3',
      [A.orgId, saved.number, "Listing changed"],
    );
    expect(logs).toHaveLength(4);
    expect(logs[0]?.before.title).toBeTruthy();
    expect(logs[0]?.after.title).toBeTruthy();
    expect(
      (await S.sql<{ n: number }>("SELECT count(*)::int AS n FROM journal_entries WHERE org_id=$1", [A.orgId]))[0]?.n,
    ).toBe(0);
  });
  it("preserves moderation, media, isolation and role checks during repeated revision", async () => {
    const api = A.manager.api.agency,
      p = { orgId: A.orgId };
    const listing = await publishedListing(S, A.orgId, A.manager, SALE);
    const params = { ...p, listingId: listing.id };
    await expect(
      api.updateListing({
        params,
        body: { ...SALE, title: "Not approved overwrite", expectedUpdatedAt: listing.updatedAt },
      }),
    ).rejects.toMatchObject({ status: 409 });
    const paused = await api.unpublishListing({ params });
    const edited = await api.updateListing({
      params,
      body: { ...SALE, title: "Corrected listing title", expectedUpdatedAt: paused.updatedAt },
    });
    expect(edited.status).toBe("paused");
    expect(edited.media.length).toBe(listing.media.length);
    await expect(
      A.viewer.api.agency.updateListing({ params, body: { ...SALE, expectedUpdatedAt: edited.updatedAt } }),
    ).rejects.toMatchObject({ status: 403 });
    const other = await agencyOrg(S);
    await expect(
      other.manager.api.agency.getListing({ params: { orgId: other.orgId, listingId: listing.id } }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      other.manager.api.agency.updateListing({ params: { orgId: other.orgId, listingId: listing.id }, body: SALE }),
    ).rejects.toMatchObject({ status: 404 });
    const submitted = await api.submitListing({ params });
    expect(submitted.status).toBe("pending_review");
  });
});
