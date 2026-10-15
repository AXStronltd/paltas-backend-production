// Short stays: one calendar per stay listing that can never hold two overlapping stays — not through the
// marketplace, the host's own bookings, confirmations racing each other, or the database directly — the host's
// prices, guest payments and refunds RECORDED to the ledger, check-out postings, owner earnings and host payouts
// approved by a second person, and moderated guest reviews.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agencyOrg,
  client,
  ledgerBalance,
  publishedListing,
  startAgencyServer,
  STAY,
  type AgencyOrg,
} from "./support/agency-fixture.js";
import { refused, type TestServer } from "./support/test-server.js";

describe("agency short stays", () => {
  let S: TestServer;
  let A: AgencyOrg;
  let villa: string; // instant book, the organisation's own
  let cottage: string; // on request, an owner's (management 20 %)
  let ownerId: string;
  let winner: { reference: string; token: string };
  const P = () => ({ orgId: A.orgId });
  const guest = (n: number) => ({ name: `Guest ${n}`, email: `guest${n}@example.test` });

  beforeAll(async () => {
    S = await startAgencyServer();
    A = await agencyOrg(S, "Coast Hosts");
    villa = (await publishedListing(S, A.orgId, A.manager, { ...STAY, instantBook: true })).id;
    const owner = await client(A.manager, A.orgId, { name: "Fatma Owner", email: "fatma@owner.test" });
    ownerId = owner.id;
    const agr = await A.manager.api.agency.createAgreement({
      params: P(),
      body: { kind: "stay_management", clientContactId: owner.id, commissionPct: 20, startsOn: "2026-01-01" },
    });
    cottage = (
      await publishedListing(S, A.orgId, A.manager, {
        ...STAY,
        title: "Galu Garden Cottage",
        priceMinor: 1_000_000,
        cleaningFeeMinor: 200_000,
        serviceFeePct: 10,
        taxPct: 0,
        minNights: 1,
        ownerContactId: owner.id,
        agreementId: agr.id,
      })
    ).id;
  });
  afterAll(() => S.close());

  it("quotes from the host's own prices: nights (with set dates), cleaning, service fee, tax", async () => {
    await A.manager.api.agency.setRates({
      params: { ...P(), listingId: villa },
      body: { rates: [{ date: "2026-10-24", priceMinor: 2_500_000 }] },
    });
    const q = await S.api.marketplace.quote({
      params: { listingId: villa },
      query: { checkIn: "2026-10-23", checkOut: "2026-10-26", guests: 4 },
    });
    // 20,000 + 25,000 + 20,000 = 65,000; cleaning 3,000; service 8 % = 5,200; tax 5 % of 73,200 = 3,660
    expect(q).toMatchObject({
      nights: 3,
      accommodationMinor: 6_500_000,
      cleaningMinor: 300_000,
      serviceFeeMinor: 520_000,
      taxMinor: 366_000,
      totalMinor: 7_686_000,
      available: true,
      problems: [],
    });
    const bad = await S.api.marketplace.quote({
      params: { listingId: villa },
      query: { checkIn: "2026-10-23", checkOut: "2026-10-24", guests: 12 },
    });
    expect(bad.problems).toEqual(["The host asks for at least 2 nights", "At most 8 guests"]);
    await refused(
      S.api.marketplace.requestBooking({
        params: { listingId: villa },
        body: { ...guest(0), checkIn: "2026-10-23", checkOut: "2026-10-24", guests: 2 },
      }),
      400,
    );
  });

  it("instant booking: many guests race for the same nights — exactly one wins", async () => {
    const tries = await Promise.allSettled(
      Array.from({ length: 8 }, (_, i) =>
        S.api.marketplace.requestBooking({
          params: { listingId: villa },
          body: { ...guest(i + 1), checkIn: "2026-11-10", checkOut: "2026-11-13", guests: 2 },
        }),
      ),
    );
    const won = tries.filter((t) => t.status === "fulfilled");
    expect(won).toHaveLength(1);
    winner = (won[0] as PromiseFulfilledResult<{ status: string; reference: string; token: string }>).value;
    expect((won[0] as PromiseFulfilledResult<{ status: string }>).value.status).toBe("confirmed");
    const lost = tries.filter((t) => t.status === "rejected") as PromiseRejectedResult[];
    expect(lost.map((t) => t.reason.status)).toEqual(Array(7).fill(409));
    const rows = await S.sql(
      "SELECT count(*)::int AS n FROM agency_stays WHERE listing_id = $1 AND status = 'confirmed' AND check_in < '2026-11-13' AND check_out > '2026-11-10'",
      [villa],
    );
    expect(rows[0].n).toBe(1);
    // overlapping by one night is refused too; back-to-back is fine
    await refused(
      S.api.marketplace.requestBooking({
        params: { listingId: villa },
        body: { ...guest(20), checkIn: "2026-11-12", checkOut: "2026-11-14", guests: 2 },
      }),
      409,
    );
    const next = await S.api.marketplace.requestBooking({
      params: { listingId: villa },
      body: { ...guest(21), checkIn: "2026-11-13", checkOut: "2026-11-15", guests: 2 },
    });
    expect(next.status).toBe("confirmed");
  });

  it("requests hold no nights; racing confirmations of overlapping requests — one wins", async () => {
    const reqs = await Promise.all(
      [1, 2, 3].map((i) =>
        S.api.marketplace.requestBooking({
          params: { listingId: cottage },
          body: { ...guest(30 + i), checkIn: "2026-10-20", checkOut: "2026-10-23", guests: 2 },
        }),
      ),
    );
    expect(reqs.map((r) => r.status)).toEqual(["requested", "requested", "requested"]);
    const stays = (
      await A.agent.api.agency.listStays({ params: P(), query: { listingId: cottage, status: "requested" } })
    ).stays;
    expect(stays).toHaveLength(3);
    const results = await Promise.allSettled([
      A.agent.api.agency.stayAction({ params: { ...P(), stayId: stays[0]!.id }, body: { action: "confirm" } }),
      A.manager.api.agency.stayAction({ params: { ...P(), stayId: stays[1]!.id }, body: { action: "confirm" } }),
      A.agent2.api.agency.stayAction({ params: { ...P(), stayId: stays[2]!.id }, body: { action: "confirm" } }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(
      (results.filter((r) => r.status === "rejected") as PromiseRejectedResult[]).map((r) => r.reason.status),
    ).toEqual([409, 409]);
    const cal = await A.manager.api.agency.listingCalendar({
      params: { ...P(), listingId: cottage },
      query: { from: "2026-10-19", to: "2026-10-24" },
    });
    expect(cal.days.map((d) => d.state)).toEqual(["free", "booked", "booked", "booked", "free"]);
    // the losers are declined; the guest sees it with their token
    const confirmed = (
      await A.agent.api.agency.listStays({ params: P(), query: { listingId: cottage, status: "confirmed" } })
    ).stays[0]!;
    for (const s of stays.filter((x) => x.id !== confirmed.id))
      await A.agent.api.agency.stayAction({
        params: { ...P(), stayId: s.id },
        body: { action: "decline", reason: "Dates taken" },
      });
    const mine = reqs.find((r) => r.reference === confirmed.id)!;
    expect(
      (await S.api.marketplace.bookingStatus({ params: { reference: mine.reference }, body: { token: mine.token } }))
        .status,
    ).toBe("confirmed");
  });

  it("the database itself refuses an overlapping stay", async () => {
    const [s] = await S.sql("SELECT * FROM agency_stays WHERE listing_id = $1 AND status = 'confirmed' LIMIT 1", [
      cottage,
    ]);
    await expect(
      S.sql(
        `INSERT INTO agency_stays (id, org_id, number, listing_id, kind, check_in, check_out, source, status)
         VALUES ('sty_direct', $1, 'STY-X', $2, 'block', $3, $4, 'owner', 'confirmed')`,
        [A.orgId, cottage, s.check_in, s.check_out],
      ),
    ).rejects.toThrow(/agency_stay_not_double_booked/);
    // a block from the host is refused the same way through the API
    await refused(
      A.manager.api.agency.createStay({
        params: P(),
        body: {
          kind: "block",
          listingId: cottage,
          checkIn: s.check_in,
          checkOut: s.check_out,
          source: "maintenance",
          note: "Paint",
        },
      }),
      409,
    );
  });

  it("money: deposits, refunds, check-out postings, owner earnings and a payout by a second person", async () => {
    // a direct booking on the owner's cottage: 3 nights × 10,000 + cleaning 2,000 + service 10 % 3,000 = 35,000
    const stay = await A.agent.api.agency.createStay({
      params: P(),
      body: {
        kind: "booking",
        listingId: cottage,
        guest: guest(50),
        checkIn: "2026-10-12",
        checkOut: "2026-10-15",
        guests: 2,
      },
    });
    expect(stay).toMatchObject({
      status: "confirmed",
      totalMinor: 3_500_000,
      ownerContactId: ownerId,
      source: "direct",
    });
    const id = stay.id;
    // a leasing agent cannot record money
    await refused(
      A.agent.api.agency.stayPayment({
        params: { ...P(), stayId: id },
        body: { kind: "payment", amountMinor: 1_000_000, method: "mobile_money", reference: "MPESA-AAA1" },
      }),
      403,
      "ROLE_NOT_ALLOWED",
    );
    const pay = (amountMinor: number, reference: string, kind: "payment" | "refund" = "payment") =>
      A.accountant.api.agency.stayPayment({
        params: { ...P(), stayId: id },
        body: { kind, amountMinor, method: "mobile_money", reference },
      });
    await pay(3_000_000, "MPESA-AAA1");
    await refused(pay(100, "MPESA-AAA1"), 409); // a reference is recorded once
    await refused(pay(600_000, "MPESA-AAA2"), 400); // more than is due
    await pay(500_000, "MPESA-AAA2", "refund");
    expect(await ledgerBalance(S, A.orgId, "2460")).toBe(-2_500_000);
    expect(await ledgerBalance(S, A.orgId, "1000")).toBe(2_500_000);

    // check-in only on the day; check-out posts revenue, owner earnings and fees
    await refused(
      A.agent.api.agency.stayAction({ params: { ...P(), stayId: id }, body: { action: "check_out" } }),
      409,
    );
    S.setToday("2026-10-12");
    await A.agent.api.agency.stayAction({ params: { ...P(), stayId: id }, body: { action: "check_in" } });
    S.setToday("2026-10-15");
    const out = await A.agent.api.agency.stayAction({ params: { ...P(), stayId: id }, body: { action: "check_out" } });
    expect(out).toMatchObject({ status: "completed", paidMinor: 2_500_000, balanceMinor: 1_000_000 });
    // nights 30,000: owner 80 % = 24,000; management 6,000 + cleaning 2,000 + service 3,000 = 11,000
    expect(await ledgerBalance(S, A.orgId, "2470")).toBe(-2_400_000);
    expect(await ledgerBalance(S, A.orgId, "4720")).toBe(-1_100_000);
    expect(await ledgerBalance(S, A.orgId, "2460")).toBe(0);
    expect(await ledgerBalance(S, A.orgId, "1190")).toBe(1_000_000);
    await refused(pay(100_000, "REF-AFTER", "refund"), 409);
    await pay(1_000_000, "MPESA-AAA3"); // the rest, after check-out, settles the receivable
    expect(await ledgerBalance(S, A.orgId, "1190")).toBe(0);

    // owner payout: prepared by the accountant, approved by the finance director — never by the same person
    const po = await A.accountant.api.agency.listPayouts({ params: P() });
    expect(po.owners).toEqual([
      {
        ownerContactId: ownerId,
        ownerName: "Fatma Owner",
        earnedMinor: 2_400_000,
        paidOutMinor: 0,
        preparedMinor: 0,
        dueMinor: 2_400_000,
      },
    ]);
    expect(po.ledgerPayableMinor).toBe(2_400_000);
    await refused(
      A.accountant.api.agency.preparePayout({ params: P(), body: { ownerContactId: ownerId, amountMinor: 2_400_001 } }),
      400,
    );
    const p = await A.accountant.api.agency.preparePayout({
      params: P(),
      body: { ownerContactId: ownerId, amountMinor: 2_000_000 },
    });
    await refused(
      A.accountant.api.agency.preparePayout({ params: P(), body: { ownerContactId: ownerId, amountMinor: 500_000 } }),
      400,
    ); // only 400,000 is left once 2,000,000 is prepared
    await refused(
      A.accountant.api.agency.decidePayout({
        params: { ...P(), payoutId: p.id },
        body: { decision: "approve", reference: "EFT-001" },
      }),
      403,
      "SEPARATION_OF_DUTIES",
    );
    await refused(
      A.manager.api.agency.decidePayout({
        params: { ...P(), payoutId: p.id },
        body: { decision: "approve", reference: "EFT-001" },
      }),
      403,
      "ROLE_NOT_ALLOWED",
    );
    const ok = await A.fd.api.agency.decidePayout({
      params: { ...P(), payoutId: p.id },
      body: { decision: "approve", reference: "EFT-001" },
    });
    expect(ok).toMatchObject({ status: "approved", reference: "EFT-001" });
    expect(await ledgerBalance(S, A.orgId, "2470")).toBe(-400_000);
    const after = await A.fd.api.agency.listPayouts({ params: P() });
    expect(after.owners[0]).toMatchObject({ earnedMinor: 2_400_000, paidOutMinor: 2_000_000, dueMinor: 400_000 });
    // the database refuses a self-approved payout too
    await expect(S.sql("UPDATE agency_payouts SET approved_by = prepared_by WHERE id = $1", [p.id])).rejects.toThrow(
      /agency_payout_second_person/,
    );
    const tb = await A.fd.api.ledger.trialBalance({ params: P(), query: {} });
    expect(tb.totals.debitMinor).toBe(tb.totals.creditMinor);
  });

  it("the organisation's own stay posts to stay revenue; a guest cancels before arrival; reviews are moderated", async () => {
    S.setToday("2026-11-10");
    const own = (
      await A.manager.api.agency.listStays({ params: P(), query: { listingId: villa, status: "confirmed" } })
    ).stays.find((s) => s.checkIn === "2026-11-10")!;
    await A.agent.api.agency.stayAction({ params: { ...P(), stayId: own.id }, body: { action: "check_in" } });
    S.setToday("2026-11-13");
    const before = await ledgerBalance(S, A.orgId, "4710");
    await A.agent.api.agency.stayAction({ params: { ...P(), stayId: own.id }, body: { action: "check_out" } });
    // 3 × 20,000 + 3,000 cleaning + 4,800 service = 67,800 revenue; tax 5 % of 67,800 = 3,390
    expect((await ledgerBalance(S, A.orgId, "4710")) - before).toBe(-6_780_000);

    // reviews: only after a completed stay, once, and public only after PALTAS approves
    const later = await S.api.marketplace.requestBooking({
      params: { listingId: villa },
      body: { ...guest(60), checkIn: "2026-11-20", checkOut: "2026-11-22", guests: 2 },
    });
    const review = (b: { reference: string; token: string }, text = "Wonderful place, spotless and calm") =>
      S.api.marketplace.review({
        params: { reference: b.reference },
        body: { token: b.token, rating: 4, text, displayName: "Wanjiku" },
      });
    await refused(review(later), 409); // not stayed yet
    // the guest cancels before arrival with their token; a wrong token is refused as unknown
    await refused(
      S.api.marketplace.cancelBooking({ params: { reference: later.reference }, body: { token: "t".repeat(32) } }),
      404,
    );
    expect(
      (await S.api.marketplace.cancelBooking({ params: { reference: later.reference }, body: { token: later.token } }))
        .status,
    ).toBe("cancelled");
    expect(
      (
        await S.api.marketplace.bookingStatus({
          params: { reference: winner.reference },
          body: { token: winner.token },
        })
      ).canReview,
    ).toBe(true);
    expect(await review(winner)).toEqual({ status: "pending" });
    await refused(review(winner, "A second review of the same stay"), 409);
    expect((await S.api.marketplace.getListing({ params: { listingId: villa } })).reviews).toEqual([]);
    const staff = await S.staff();
    const queue = await staff.api.marketplace.reviewQueue({ query: {} });
    expect(queue.reviews.map((r) => r.listingTitle)).toEqual(["Diani Beach Villa"]);
    await refused(
      staff.api.marketplace.moderateReview({
        params: { reviewId: queue.reviews[0]!.id },
        body: { decision: "reject", note: "" },
      }),
      400,
    ); // a rejection needs its reason
    await staff.api.marketplace.moderateReview({
      params: { reviewId: queue.reviews[0]!.id },
      body: { decision: "approve", note: "" },
    });
    const shown = await S.api.marketplace.getListing({ params: { listingId: villa } });
    expect(shown.reviews.map((r) => [r.rating, r.displayName])).toEqual([[4, "Wanjiku"]]);
    expect(shown.rating).toEqual({ average: 4, count: 1 });
    expect(JSON.stringify(shown)).not.toContain("guest1@example.test");
  });
});
