// A guest's booking request and a buyer's offer can be sent again safely: with the browser's random request id, a
// repeat (a lost answer, a double click, a retry after a timeout) returns the same booking or offer with the same
// private code, and nothing is created twice — also when both copies arrive at the same moment. Without a request id
// nothing changes. A malformed request id is refused.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agencyOrg,
  publishedListing,
  SALE,
  startAgencyServer,
  STAY,
  type AgencyOrg,
} from "./support/agency-fixture.js";
import { refused, type TestServer } from "./support/test-server.js";

const rid = (s: string) => (s + "-request-id-0123456789abcdef").slice(0, 32);

describe("repeatable marketplace requests", () => {
  let S: TestServer;
  let A: AgencyOrg;
  let stay: string;
  let sale: string;
  beforeAll(async () => {
    S = await startAgencyServer(process.env.DBG ? { logLevel: "error" } : {});
    A = await agencyOrg(S, "Coast Hosts");
    stay = (await publishedListing(S, A.orgId, A.manager, STAY)).id;
    sale = (await publishedListing(S, A.orgId, A.manager, SALE)).id;
  });
  afterAll(() => S.close());
  const count = async (table: string, listing: string) =>
    (await S.sql<{ n: number }>(`SELECT count(*)::int AS n FROM ${table} WHERE listing_id = $1`, [listing]))[0]!.n;

  it("a booking sent twice is one booking with one private code", async () => {
    const body = {
      name: "Guest One",
      email: "guest.one@example.test",
      checkIn: "2026-11-02",
      checkOut: "2026-11-05",
      guests: 2,
      requestId: rid("booking-a"),
    };
    const first = await S.api.marketplace.requestBooking({ params: { listingId: stay }, body });
    const second = await S.api.marketplace.requestBooking({ params: { listingId: stay }, body });
    expect(second.reference).toBe(first.reference);
    expect(second.token).toBe(first.token);
    expect(second.quote).toEqual(first.quote);
    expect(await count("agency_stays", stay)).toBe(1);
    const status = await S.api.marketplace.bookingStatus({
      params: { reference: first.reference },
      body: { token: first.token },
    });
    expect(status.reference).toBe(first.reference);
  });

  it("two copies at the same moment still make one booking", async () => {
    const body = {
      name: "Guest Two",
      email: "guest.two@example.test",
      checkIn: "2026-11-10",
      checkOut: "2026-11-12",
      guests: 1,
      requestId: rid("booking-b"),
    };
    const answers = await Promise.all(
      [1, 2, 3].map(() => S.api.marketplace.requestBooking({ params: { listingId: stay }, body })),
    );
    expect(new Set(answers.map((a) => a.reference)).size).toBe(1);
    expect(new Set(answers.map((a) => a.token)).size).toBe(1);
    expect(await count("agency_stays", stay)).toBe(2);
  });

  it("an offer sent twice is one offer with one private code", async () => {
    const body = {
      name: "Buyer One",
      email: "buyer.one@example.test",
      amountMinor: 1_700_000_000,
      requestId: rid("offer-a"),
    };
    const first = await S.api.marketplace.makeOffer({ params: { listingId: sale }, body });
    const again = await Promise.all(
      [1, 2].map(() => S.api.marketplace.makeOffer({ params: { listingId: sale }, body })),
    );
    expect(again.map((a) => [a.reference, a.token])).toEqual([
      [first.reference, first.token],
      [first.reference, first.token],
    ]);
    expect(await count("agency_offers", sale)).toBe(1);
  });

  it("without a request id nothing changes; a malformed one is refused", async () => {
    const body = {
      name: "Guest Three",
      email: "guest.three@example.test",
      checkIn: "2026-11-20",
      checkOut: "2026-11-22",
      guests: 1,
    };
    const a = await S.api.marketplace.requestBooking({ params: { listingId: stay }, body });
    expect(a.token).toBeTruthy();
    await refused(
      S.raw("POST", `/api/v1/public/listings/${stay}/bookings`, {
        ...body,
        checkIn: "2026-12-01",
        checkOut: "2026-12-03",
        requestId: "short",
      }).then((r) => {
        if (r.status >= 400)
          throw Object.assign(new Error(r.body?.error?.message), { status: r.status, code: r.body?.error?.code });
        return r;
      }),
      400,
    );
  });
});
