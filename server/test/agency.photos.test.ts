import { afterAll, beforeAll, describe, expect, it } from "vitest";
import sharp from "sharp";
import { agencyOrg, photoBody, SALE, sha, startAgencyServer, type AgencyOrg } from "./support/agency-fixture.js";
import { refused, type TestServer } from "./support/test-server.js";

describe("persistent listing photos", () => {
  let S: TestServer;
  let A: AgencyOrg;
  let B: AgencyOrg;
  beforeAll(async () => {
    S = await startAgencyServer();
    A = await agencyOrg(S);
    B = await agencyOrg(S);
  });
  afterAll(() => S.close());

  it("stores real normalized bytes, isolates companies and serves images only while published", async () => {
    const p = { orgId: A.orgId };
    const l = await A.manager.api.agency.createListing({ params: p, body: SALE });
    const params = { ...p, listingId: l.id };
    const upload = await photoBody();
    await refused(B.manager.api.agency.uploadPhoto({ params: { orgId: B.orgId, listingId: l.id }, body: upload }), 404);
    await refused(A.viewer.api.agency.uploadPhoto({ params, body: upload }), 403);
    const r = await A.manager.api.agency.uploadPhoto({ params, body: upload });
    expect(r.stored).toBe(true);
    expect(r.media.contentType).toBe("image/jpeg");
    expect(r.media.url).toMatch(/\/content$/);
    await refused(A.manager.api.agency.uploadPhoto({ params, body: upload }), 409);
    const url = S.base + r.media.url;
    expect((await fetch(url)).status).toBe(404);
    await A.manager.api.agency.submitListing({ params });
    expect((await fetch(url)).status).toBe(404);
    const staff = await S.staff();
    await staff.api.marketplace.approveListing({ params: { listingId: l.id }, body: { note: "Photo checked" } });
    const response = await fetch(url);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/jpeg");
    expect(response.headers.get("cache-control")).toBe("no-store");
    const bytes = Buffer.from(await response.arrayBuffer());
    expect((await sharp(bytes).metadata()).format).toBe("jpeg");
    expect(sha(bytes.toString("base64"))).not.toBe(sha(upload.contentBase64));
    expect(
      (await S.sql<{ n: number }>("SELECT count(*)::int n FROM agency_photo_files WHERE media_id=$1", [r.media.id]))[0]
        ?.n,
    ).toBe(1);
    expect(await S.api.marketplace.mediaContent({ params: { listingId: l.id, mediaId: r.media.id } })).toMatch(
      /^data:image\/jpeg;base64,/,
    );
    await staff.api.admin.setSubscriptionStatus({
      params: p,
      body: { status: "suspended", reason: "Photo access isolation check", product: "agency" },
    });
    expect((await fetch(url)).status).toBe(404);
    await staff.api.admin.setSubscriptionStatus({
      params: p,
      body: { status: "active", reason: "Restore synthetic test subscription", product: "agency" },
    });
    await A.manager.api.agency.unpublishListing({ params });
    expect((await fetch(url)).status).toBe(404);
    await A.manager.api.agency.removeMedia({ params: { ...params, mediaId: r.media.id } });
    expect(
      (await S.sql<{ n: number }>("SELECT count(*)::int n FROM agency_photo_files WHERE media_id=$1", [r.media.id]))[0]
        ?.n,
    ).toBe(0);
  });

  it("rejects fake, oversized, corrupt or active images and metadata-only submission", async () => {
    const l = await A.manager.api.agency.createListing({ params: { orgId: A.orgId }, body: SALE });
    const params = { orgId: A.orgId, listingId: l.id };
    for (const content of [
      Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'),
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      Buffer.alloc(2 * 1024 * 1024 + 1),
    ]) {
      await refused(
        A.manager.api.agency.uploadPhoto({
          params,
          body: { fileName: "photo.jpg", contentBase64: content.toString("base64") },
        }),
        400,
      );
    }
    await A.manager.api.agency.addMedia({
      params,
      body: { kind: "photo", fileName: "fake.jpg", contentType: "image/jpeg", sizeBytes: 100, sha256: sha("no-bytes") },
    });
    await refused(A.manager.api.agency.submitListing({ params }), 400);
    expect((await A.manager.api.agency.getListing({ params })).status).toBe("draft");
    expect(
      (
        await S.sql<{ n: number }>(
          "SELECT count(*)::int n FROM agency_photo_files f JOIN agency_listing_media m ON m.id=f.media_id WHERE m.listing_id=$1",
          [l.id],
        )
      )[0]?.n,
    ).toBe(0);
  });
});
