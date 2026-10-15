// Development rules: the last unit can never be sold twice (concurrent acceptances, the database constraints),
// offer approval levels, reservation and offer expiry, price lists, approval limits, related-party and over-budget
// orders, budget changes, quotations, duplicate invoices, bank-detail changes, every separation-of-duties rule, role
// refusals, and another organisation's records answering "not found".
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  buildProject,
  devOrg,
  doc,
  M,
  PLAN_10_50_40,
  PLAN_CASH,
  startDevServer,
  type DevStaff,
} from "./support/development-fixture.js";
import { refused, TODAY, type Person, type TestServer } from "./support/test-server.js";

describe("Real Estate Development: rules", () => {
  let S: TestServer;
  let orgId: string;
  let st: DevStaff;
  let projectId: string;
  let units: { id: string; unitNo: string }[];
  const d = (p: Person) => p.api.development;
  const O = () => ({ orgId });
  let n = 0;
  const buyer = (p: Person, name: string) =>
    d(p).createBuyer({ params: O(), body: { name, phone: `+254 711 ${String(100000 + ++n).padStart(6, "0")}` } });
  /** An offer submitted to the buyer (no approval needed: list price, standard plan). */
  const submitted = async (agent: Person, buyerId: string, unitId: string, body: Record<string, unknown> = {}) => {
    const o = await d(agent).createOffer({
      params: O(),
      body: { buyerId, unitId, priceMinor: M(15e6), plan: PLAN_10_50_40, ...body } as never,
    });
    return d(agent).submitOffer({ params: { orgId, offerId: o.id } });
  };

  beforeAll(async () => {
    S = await startDevServer();
    const o = await devOrg(S, "Mvuli Developers");
    orgId = o.orgId;
    st = o.staff;
    const p = await buildProject(st.ceo, orgId, { units: 8 });
    projectId = p.projectId;
    units = p.units;
  });
  afterAll(() => S.close());

  it("the last unit: concurrent acceptances — exactly one wins, every other is refused", async () => {
    const unitId = units[0]!.id;
    const offers = [];
    for (let i = 0; i < 5; i++) {
      const agent = i % 2 ? st.ag2 : st.ag1;
      const b = await buyer(agent, `Concurrent Buyer ${i}`);
      offers.push({ agent, offer: await submitted(agent, b.id, unitId) });
    }
    const tries = await Promise.allSettled(
      offers.map((o) =>
        d(o.agent).respondToOffer({ params: { orgId, offerId: o.offer.id }, body: { response: "accept" } }),
      ),
    );
    expect(tries.filter((t) => t.status === "fulfilled").length).toBe(1);
    for (const t of tries.filter((x) => x.status === "rejected"))
      expect((t as PromiseRejectedResult).reason.status).toBe(409);
    const open = await S.sql(
      "SELECT count(*)::int AS n FROM dev_reservations WHERE unit_id = $1 AND status IN ('awaiting_approval', 'active')",
      [unitId],
    );
    expect(open[0].n).toBe(1);
    const [u] = await S.sql("SELECT status FROM dev_units WHERE id = $1", [unitId]);
    expect(u.status).toBe("on_hold");
    // and the database itself refuses a second open reservation or a second live contract for a unit
    const [r] = await S.sql("SELECT buyer_id FROM dev_reservations WHERE unit_id = $1", [unitId]);
    await expect(
      S.sql(
        "INSERT INTO dev_reservations (id, org_id, unit_id, buyer_id, date, status) VALUES ('x1', $1, $2, $3, $4, 'active')",
        [orgId, unitId, r.buyer_id, TODAY],
      ),
    ).rejects.toThrow(/dev_reservations_one_open_per_unit/);
    await S.sql(
      "INSERT INTO dev_contracts (id, org_id, unit_id, buyer_id, date, price_minor, status) VALUES ('k1', $1, $2, $3, $4, 1, 'active')",
      [orgId, units[7]!.id, r.buyer_id, TODAY],
    );
    await expect(
      S.sql(
        "INSERT INTO dev_contracts (id, org_id, unit_id, buyer_id, date, price_minor) VALUES ('k2', $1, $2, $3, $4, 1)",
        [orgId, units[7]!.id, r.buyer_id, TODAY],
      ),
    ).rejects.toThrow(/dev_contracts_one_live_per_unit/);
    await S.sql("UPDATE dev_contracts SET status = 'cancelled' WHERE id = 'k1'");
  });

  it("a unit on hold, reserved or sold cannot take a new offer; a contract is signed once", async () => {
    const b = await buyer(st.ag1, "Late Buyer");
    await refused(
      d(st.ag1).createOffer({
        params: O(),
        body: { buyerId: b.id, unitId: units[0]!.id, priceMinor: M(15e6), plan: PLAN_CASH },
      }),
      409,
    );
    const o = await submitted(st.ag1, b.id, units[1]!.id, { plan: PLAN_CASH });
    const acc = await d(st.ag1).respondToOffer({ params: { orgId, offerId: o.id }, body: { response: "accept" } });
    // the reservation is approved by a manager who does not own the sale
    await refused(
      d(st.ag1).approveReservation({ params: { orgId, reservationId: acc.reservationId! } }),
      403,
      "ROLE_NOT_ALLOWED",
    );
    await d(st.sm).approveReservation({ params: { orgId, reservationId: acc.reservationId! } });
    const signedDoc = (await doc(st.sm, orgId, "sa.pdf")).id;
    await refused(
      d(st.sm).signContract({
        params: { orgId, reservationId: acc.reservationId! },
        body: { date: "2026-12-01", signedDocumentId: signedDoc },
      }),
      400,
    );
    await refused(
      d(st.sm).signContract({
        params: { orgId, reservationId: acc.reservationId! },
        body: { date: TODAY, signedDocumentId: "nope" },
      }),
      400,
    );
    await d(st.sm).signContract({
      params: { orgId, reservationId: acc.reservationId! },
      body: { date: TODAY, signedDocumentId: signedDoc },
    });
    await refused(
      d(st.sm).signContract({
        params: { orgId, reservationId: acc.reservationId! },
        body: { date: TODAY, signedDocumentId: signedDoc },
      }),
      409,
    );
  });

  it("offer approval levels: manager for a 4 % discount, the CEO for 6 %; never by the preparer; terms changed → approval gone", async () => {
    const b = await buyer(st.ag1, "Discount Buyer");
    const four = await submitted(st.ag1, b.id, units[2]!.id, { priceMinor: M(14.4e6) });
    expect([four.status, four.approval?.level, four.discountBp]).toEqual(["awaiting_approval", "manager", 400]);
    await refused(
      d(st.ag1).decideOffer({ params: { orgId, offerId: four.id }, body: { approve: true } }),
      403,
      "ROLE_NOT_ALLOWED",
    );
    expect((await d(st.sm).approvals({ params: O() })).items.map((i) => i.id)).toContain(four.id);
    const ok = await d(st.sm).decideOffer({ params: { orgId, offerId: four.id }, body: { approve: true } });
    expect([ok.status, ok.approval?.decidedBy]).toEqual(["submitted", st.sm.userId]);

    const six = await submitted(st.ag2, (await buyer(st.ag2, "Big Discount Buyer")).id, units[3]!.id, {
      priceMinor: M(14.1e6),
    });
    expect(six.approval?.level).toBe("executive");
    await refused(
      d(st.sm).decideOffer({ params: { orgId, offerId: six.id }, body: { approve: true } }),
      403,
      "ROLE_NOT_ALLOWED",
    );
    await refused(
      d(st.sm).decideOffer({ params: { orgId, offerId: six.id }, body: { approve: false, reason: "no" } }),
      403,
    );
    const declined = await d(st.ceo).decideOffer({
      params: { orgId, offerId: six.id },
      body: { approve: false, reason: "Too deep a discount for Block A" },
    });
    expect([declined.status, declined.approval?.status]).toEqual(["draft", "declined"]);
    // a sales manager who prepares an offer cannot approve it
    const smOffer = await d(st.sm).createOffer({
      params: O(),
      body: {
        buyerId: (await buyer(st.sm, "Manager's Buyer")).id,
        unitId: units[4]!.id,
        priceMinor: M(14.4e6),
        plan: PLAN_10_50_40,
      },
    });
    await d(st.sm).submitOffer({ params: { orgId, offerId: smOffer.id } });
    await refused(
      d(st.sm).decideOffer({ params: { orgId, offerId: smOffer.id }, body: { approve: true } }),
      403,
      "SEPARATION_OF_DUTIES",
    );
    // the buyer counters below the approved terms: accepting it needs a new approval
    await d(st.ag1).respondToOffer({
      params: { orgId, offerId: four.id },
      body: { response: "counter", counter: { priceMinor: M(14.1e6), plan: PLAN_10_50_40, note: "6 % or nothing" } },
    });
    const again = await d(st.ag1).acceptCounter({ params: { orgId, offerId: four.id } });
    expect([again.status, again.approval?.level, again.priceMinor]).toEqual([
      "awaiting_approval",
      "executive",
      M(14.1e6),
    ]);
    const done = await d(st.ceo).decideOffer({ params: { orgId, offerId: four.id }, body: { approve: true } });
    expect(done.status).toBe("accepted");
  });

  it("expiry: an offer past its validity cannot be accepted; a lapsed reservation releases the unit", async () => {
    const b = await buyer(st.ag2, "Slow Buyer");
    const o = await submitted(st.ag2, b.id, units[5]!.id, { validDays: 1 });
    S.setToday("2026-10-13");
    await refused(d(st.ag2).respondToOffer({ params: { orgId, offerId: o.id }, body: { response: "accept" } }), 409);
    expect((await d(st.ag2).listOffers({ params: O(), query: { buyerId: b.id } })).offers[0]!.status).toBe("expired");
    const o2 = await submitted(st.ag2, b.id, units[5]!.id);
    const acc = await d(st.ag2).respondToOffer({ params: { orgId, offerId: o2.id }, body: { response: "accept" } });
    const r = await d(st.sm).approveReservation({ params: { orgId, reservationId: acc.reservationId! } });
    expect(r.expiryDate).toBe("2026-10-27");
    S.setToday("2026-10-28");
    const res = await d(st.sm).expireSales({ params: O() });
    expect(res).toEqual({ offersExpired: expect.any(Number), reservationsExpired: 1 });
    const { units: avail } = await d(st.aud).listUnits({
      params: { orgId, projectId },
      query: { status: "available" },
    });
    expect(avail.map((u) => u.id)).toContain(units[5]!.id);
    await refused(
      d(st.sm).signContract({
        params: { orgId, reservationId: r.id },
        body: { date: "2026-10-28", signedDocumentId: (await doc(st.sm, orgId, "late.pdf")).id },
      }),
      409,
    );
    S.setToday(TODAY);
  });

  it("price lists: prepared by one sales manager, approved by another; only unsold units change price", async () => {
    const P = { orgId, projectId };
    const pl = await d(st.sm).createPriceList({
      params: P,
      body: {
        effectiveDate: TODAY,
        note: "November release",
        items: [{ unitId: units[6]!.id, priceMinor: M(15.75e6) }],
      },
    });
    await refused(
      d(st.sm).decidePriceList({ params: { orgId, priceListId: pl.id }, body: { approve: true } }),
      403,
      "SEPARATION_OF_DUTIES",
    );
    await refused(
      d(st.ag1).decidePriceList({ params: { orgId, priceListId: pl.id }, body: { approve: true } }),
      403,
      "ROLE_NOT_ALLOWED",
    );
    const ok = await d(st.sm2).decidePriceList({ params: { orgId, priceListId: pl.id }, body: { approve: true } });
    expect([ok.status, ok.items[0]!.oldPriceMinor, ok.items[0]!.priceMinor]).toEqual(["approved", M(15e6), M(15.75e6)]);
    const u = (await d(st.aud).listUnits({ params: P, query: {} })).units.find((x) => x.id === units[6]!.id)!;
    expect(u.listPriceMinor).toBe(M(15.75e6));
    // sold stock is not on a price list
    await refused(
      d(st.sm).createPriceList({
        params: P,
        body: { effectiveDate: TODAY, items: [{ unitId: units[1]!.id, priceMinor: 1 }] },
      }),
      409,
    );
  });

  it("agents see only their own buyers; duplicates are refused; managers reassign and merge", async () => {
    const mine = await buyer(st.ag1, "Agent One Buyer");
    await refused(d(st.ag2).getBuyer({ params: { orgId, buyerId: mine.id } }), 404);
    expect((await d(st.ag2).listBuyers({ params: O(), query: {} })).buyers.map((b) => b.id)).not.toContain(mine.id);
    await refused(
      d(st.ag2).createOffer({
        params: O(),
        body: { buyerId: mine.id, unitId: units[6]!.id, priceMinor: M(15e6), plan: PLAN_CASH },
      }),
      404,
    );
    await refused(
      d(st.ag1).assignBuyer({ params: { orgId, buyerId: mine.id }, body: { agentUserId: st.ag2.userId } }),
      403,
      "ROLE_NOT_ALLOWED",
    );
    await d(st.sm).assignBuyer({ params: { orgId, buyerId: mine.id }, body: { agentUserId: st.ag2.userId } });
    expect((await d(st.ag2).getBuyer({ params: { orgId, buyerId: mine.id } })).agentUserId).toBe(st.ag2.userId);
    await refused(d(st.ag1).getBuyer({ params: { orgId, buyerId: mine.id } }), 404);
    const a = await d(st.sm).createBuyer({
      params: O(),
      body: { name: "Hassan Abdi", email: "hassan@example.com", agentUserId: st.ag1.userId },
    });
    await refused(d(st.sm).createBuyer({ params: O(), body: { name: "H. Abdi", email: "HASSAN@example.com" } }), 409);
    const bb = await d(st.sm).createBuyer({ params: O(), body: { name: "Hassan A.", phone: "+254 799 123 456" } });
    const kept = await d(st.sm).mergeBuyers({
      params: { orgId, buyerId: a.id },
      body: { duplicateId: bb.id, reason: "Same person, two enquiries" },
    });
    expect(kept.status).toBe("active");
    expect((await d(st.sm).getBuyer({ params: { orgId, buyerId: bb.id } })).status).toBe("merged");
    const c = await d(st.ag1).recordCorrespondence({
      params: { orgId, buyerId: a.id },
      body: { channel: "whatsapp", subject: "Payment plan question" },
    });
    expect(c.delivery).toContain("not sent");
  });

  it("buyer payments: reported once per reference; verified only by finance and never by the person who recorded it", async () => {
    const [k] = await S.sql(
      "SELECT k.id FROM dev_contracts k WHERE k.org_id = $1 AND k.status = 'active' ORDER BY k.created_at LIMIT 1",
      [orgId],
    );
    const sa = await d(st.fd).contractStatement({ params: { orgId, contractId: k.id }, query: {} });
    const first = sa.instalments[0]!;
    const rep = await d(st.acct).reportPayment({
      params: { orgId, contractId: k.id },
      body: {
        instalmentId: first.id,
        amountMinor: first.amountMinor,
        method: "bank_transfer",
        reference: "FT-RULES-0001",
        date: TODAY,
      },
    });
    await refused(
      d(st.acct).verifyPayment({ params: { orgId, reportId: rep.id }, body: { approve: true } }),
      403,
      "SEPARATION_OF_DUTIES",
    );
    await refused(
      d(st.sm).verifyPayment({ params: { orgId, reportId: rep.id }, body: { approve: true } }),
      403,
      "ROLE_NOT_ALLOWED",
    );
    await expect(
      S.sql("UPDATE dev_payment_reports SET verified_by = reported_by WHERE id = $1", [rep.id]),
    ).rejects.toThrow(/dev_payment_verified_by_second_person/);
    const no = await d(st.fd).verifyPayment({
      params: { orgId, reportId: rep.id },
      body: { approve: false, reason: "Not on the bank statement" },
    });
    expect(no.status).toBe("rejected");
    // a rejected reference may be recorded again, a verified one never
    const again = await d(st.acct).reportPayment({
      params: { orgId, contractId: k.id },
      body: {
        instalmentId: first.id,
        amountMinor: first.amountMinor,
        method: "bank_transfer",
        reference: "FT-RULES-0001",
        date: TODAY,
      },
    });
    await d(st.treasury).verifyPayment({ params: { orgId, reportId: again.id }, body: { approve: true } });
    await refused(
      d(st.fd).reportPayment({
        params: { orgId, contractId: k.id },
        body: { amountMinor: 100, method: "cash", reference: "FT-RULES-0001", date: TODAY },
      }),
      409,
    );
  });

  it("procurement: approval limits, related-party orders, over-budget orders, budget changes and quotations", async () => {
    const P = { orgId, projectId };
    await d(st.pm).setBudget({
      params: P,
      body: {
        lines: [
          { costCode: "07", originalMinor: M(5e6), etcMinor: M(5e6) },
          { costCode: "13", originalMinor: M(3e6) },
        ],
      },
    });
    await refused(d(st.pm).setBudget({ params: P, body: { lines: [{ costCode: "07", originalMinor: M(9e6) }] } }), 409);
    // limits: procurement 5M; a 6M requisition needs finance
    const req = await d(st.proc).createRequisition({
      params: P,
      body: { costCode: "07", item: "Floor tiles 600x600", qty: 3000, unit: "m²", estUnitPriceMinor: M(2000) },
    });
    const pmErr = await refused(
      d(st.pm).decideRequisition({ params: { orgId, requisitionId: req.id }, body: { approve: true } }),
      403,
      "FORBIDDEN",
    );
    expect(pmErr.message).toContain("approval limit");
    await refused(
      d(st.ap).decideRequisition({ params: { orgId, requisitionId: req.id }, body: { approve: true } }),
      403,
      "ROLE_NOT_ALLOWED",
    );
    await d(st.fd).decideRequisition({ params: { orgId, requisitionId: req.id }, body: { approve: true } });

    // quotations: weighted score picks the best value, an award to someone else needs a reason
    const sup = async (name: string, rating: number, o: Record<string, unknown> = {}) => {
      const s = await d(st.proc).registerSupplier({
        params: O(),
        body: {
          kind: "supplier",
          name,
          taxId: `PIN-${name.replace(/\W/g, "")}`,
          bankAccount: "1234567890",
          ...o,
        } as never,
      });
      await d(st.fd).approveSupplier({ params: { orgId, supplierId: s.id }, body: { rating } });
      return s.id;
    };
    const ceramica = await sup("Ceramica Imports", 4.3);
    const tileWorld = await sup("Tile World", 3.5);
    const rfq = await d(st.proc).createRfq({
      params: { orgId, requisitionId: req.id },
      body: { supplierIds: [ceramica, tileWorld], closes: "2026-10-20" },
    });
    await d(st.proc).recordBid({
      params: { orgId, rfqId: rfq.id },
      body: { supplierId: ceramica, unitPriceMinor: M(1900), leadDays: 10 },
    });
    const bids = await d(st.proc).recordBid({
      params: { orgId, rfqId: rfq.id },
      body: { supplierId: tileWorld, unitPriceMinor: M(1850), leadDays: 30 },
    });
    expect(bids.bids[0]!.supplierId).toBe(ceramica);
    await refused(d(st.proc).awardRfq({ params: { orgId, rfqId: rfq.id }, body: { supplierId: tileWorld } }), 400);
    const awarded = await d(st.proc).awardRfq({ params: { orgId, rfqId: rfq.id }, body: {} });
    expect([awarded.status, awarded.awardedSupplierId]).toEqual(["awarded", ceramica]);
    const po = (await d(st.aud).listPurchaseOrders({ params: O(), query: { projectId } })).purchaseOrders.find(
      (x) => x.id === awarded.purchaseOrderId,
    )!;
    expect([po.status, po.amountMinor]).toEqual(["pending_approval", M(5.7e6)]);
    // over the revised budget of 07 (5M): finance is blocked, the CEO may make the exception
    await refused(d(st.fd).decidePurchaseOrder({ params: { orgId, poId: po.id }, body: { approve: true } }), 409);
    // transfer budget from contingency: requested by the PM, approved by finance
    const bt = await d(st.pm).requestBudgetChange({
      params: P,
      body: {
        kind: "transfer",
        fromCode: "13",
        toCode: "07",
        amountMinor: M(1e6),
        reason: "Upgrade to porcelain tiles",
      },
    });
    await refused(
      d(st.pm).decideBudgetChange({ params: { orgId, changeId: bt.id }, body: { approve: true } }),
      403,
      "SEPARATION_OF_DUTIES",
    );
    await d(st.fd).decideBudgetChange({ params: { orgId, changeId: bt.id }, body: { approve: true } });
    const tooMuch = await d(st.pm).requestBudgetChange({
      params: P,
      body: {
        kind: "transfer",
        fromCode: "13",
        toCode: "07",
        amountMinor: M(5e6),
        reason: "More than contingency holds",
      },
    });
    await refused(
      d(st.fd).decideBudgetChange({ params: { orgId, changeId: tooMuch.id }, body: { approve: true } }),
      409,
    );
    const okPo = await d(st.fd).decidePurchaseOrder({ params: { orgId, poId: po.id }, body: { approve: true } });
    expect(okPo.status).toBe("approved");
    const cr = await d(st.pm).costReport({ params: P });
    expect(cr.rows.find((r) => r.costCode === "07")).toMatchObject({
      revisedMinor: M(6e6),
      committedMinor: M(5.7e6),
      etcMinor: 0,
    });
    expect(cr.rows.find((r) => r.costCode === "13")!.revisedMinor).toBe(M(2e6));
    const co = await d(st.pm).requestBudgetChange({
      params: P,
      body: { kind: "change_order", fromCode: "13", toCode: "08", amountMinor: M(1e6), reason: "Rooftop solar PV" },
    });
    await d(st.ceo).decideBudgetChange({ params: { orgId, changeId: co.id }, body: { approve: true } });
    expect((await d(st.pm).costReport({ params: P })).rows.find((r) => r.costCode === "08")).toMatchObject({
      revisedMinor: M(1e6),
      etcMinor: M(1e6),
      eacMinor: M(1e6),
    });

    // a related-party supplier: any value needs the CEO
    const related = await sup("Mwangi & Sons Hardware", 3.9, { relatedParty: true, relatedNote: "Director's sibling" });
    const rp = await d(st.proc).createPurchaseOrder({
      params: P,
      body: {
        kind: "po",
        supplierId: related,
        costCode: "08",
        description: "Door furniture",
        lines: [{ item: "Handle set", unit: "set", qty: 10, unitPriceMinor: M(7500) }],
      },
    });
    await refused(
      d(st.fd).decidePurchaseOrder({ params: { orgId, poId: rp.id }, body: { approve: true } }),
      403,
      "FORBIDDEN",
    );
    expect(
      (await d(st.ceo).decidePurchaseOrder({ params: { orgId, poId: rp.id }, body: { approve: true } })).status,
    ).toBe("approved");
    await expect(
      S.sql("UPDATE dev_purchase_orders SET approved_by = prepared_by WHERE id = $1", [rp.id]),
    ).rejects.toThrow(/dev_purchase_order_second_person/);
  });

  it("supplier invoices: duplicates caught, capturer cannot approve; bank-detail changes block payment until verified by another person", async () => {
    const s = await d(st.proc).registerSupplier({
      params: O(),
      body: { kind: "contractor", name: "Maji Plumbing Contractors", taxId: "P051777777M", bankAccount: "5555444433" },
    });
    await refused(
      d(st.ap).captureInvoice({
        params: O(),
        body: {
          supplierId: s.id,
          projectId,
          costCode: "08",
          supplierInvoiceNo: "MPC-1",
          date: TODAY,
          dueDate: TODAY,
          description: "x",
          vatBp: 0,
        },
      }),
      400,
    );
    await d(st.fd).approveSupplier({ params: { orgId, supplierId: s.id }, body: {} });
    // finance registers and approves its own supplier: refused
    const own = await d(st.fd).registerSupplier({
      params: O(),
      body: { kind: "supplier", name: "Own Supplier", taxId: "P0OWN", bankAccount: "1111222233" },
    });
    await refused(
      d(st.fd).approveSupplier({ params: { orgId, supplierId: own.id }, body: {} }),
      403,
      "SEPARATION_OF_DUTIES",
    );
    const capture = async (p: Person, no: string) =>
      d(p).captureInvoice({
        params: O(),
        body: {
          supplierId: s.id,
          projectId,
          costCode: "08",
          supplierInvoiceNo: no,
          date: TODAY,
          dueDate: TODAY,
          description: "Plumbing first fix",
          netMinor: M(23_500),
          vatBp: 1600,
          whtBp: 300,
          evidenceDocumentId: (await doc(p, orgId, `${no}.pdf`)).id,
        },
      });
    const first = await capture(st.fd, "MPC-1187");
    expect(first.status).toBe("matched");
    await refused(
      d(st.fd).decideInvoice({ params: { orgId, invoiceId: first.id }, body: { action: "approve" } }),
      403,
      "SEPARATION_OF_DUTIES",
    );
    const dup = await capture(st.ap, "MPC 1187");
    expect([dup.status, dup.exceptions[0]]).toEqual(["exception", `Possible duplicate of MPC-1187 (${first.number})`]);
    await refused(
      d(st.fd).decideInvoice({
        params: { orgId, invoiceId: dup.id },
        body: { action: "override", reason: "It is fine" },
      }),
      403,
      "ROLE_NOT_ALLOWED",
    );
    expect(
      (await d(st.ap).decideInvoice({ params: { orgId, invoiceId: dup.id }, body: { action: "duplicate" } })).status,
    ).toBe("duplicate");
    await d(st.ceo).decideInvoice({ params: { orgId, invoiceId: first.id }, body: { action: "approve" } });

    const bc = await d(st.ap).logBankChange({
      params: { orgId, supplierId: s.id },
      body: { newAccount: "99998888", receivedVia: "Email from a new domain" },
    });
    expect((await d(st.aud).listSuppliers({ params: O() })).suppliers.find((x) => x.id === s.id)!.paymentsBlocked).toBe(
      true,
    );
    await refused(d(st.ap).preparePaymentRun({ params: O(), body: { invoiceIds: [first.id] } }), 409);
    await refused(
      d(st.ap).verifyBankChange({
        params: { orgId, changeId: bc.id },
        body: { callbackNote: "Called the number on file" },
      }),
      403,
      "ROLE_NOT_ALLOWED",
    );
    const fdChange = await d(st.fd).logBankChange({
      params: { orgId, supplierId: own.id },
      body: { newAccount: "77776666", receivedVia: "Letter" },
    });
    await refused(
      d(st.fd).verifyBankChange({ params: { orgId, changeId: fdChange.id }, body: { callbackNote: "Called myself" } }),
      403,
      "SEPARATION_OF_DUTIES",
    );
    const v = await d(st.fd).verifyBankChange({
      params: { orgId, changeId: bc.id },
      body: { callbackNote: "Finance director, number on file since 2024" },
    });
    expect(v.status).toBe("on_hold"); // still blocked for the 48-hour hold
    await refused(d(st.ap).preparePaymentRun({ params: O(), body: { invoiceIds: [first.id] } }), 409);
    await S.sql("UPDATE dev_bank_changes SET hold_until = now() - interval '1 minute' WHERE id = $1", [bc.id]);
    const after = (await d(st.aud).listSuppliers({ params: O() })).suppliers.find((x) => x.id === s.id)!;
    expect([after.paymentsBlocked, after.bankAccount]).toEqual([false, "••8888"]);

    // payment runs: the preparer cannot approve, the approver cannot execute
    const run = await d(st.fd).preparePaymentRun({ params: O(), body: { invoiceIds: [first.id] } });
    await refused(d(st.fd).approvePaymentRun({ params: { orgId, runId: run.id } }), 403, "SEPARATION_OF_DUTIES");
    await d(st.ceo).approvePaymentRun({ params: { orgId, runId: run.id } });
    await refused(d(st.ceo).executePaymentRun({ params: { orgId, runId: run.id } }), 403, "SEPARATION_OF_DUTIES");
    const ex = await d(st.treasury).executePaymentRun({ params: { orgId, runId: run.id } });
    const pay = ex.run.payments[0]!;
    // a returned payment is reversed by finance: the invoice is owed again
    await refused(
      d(st.pm).reverseSupplierPayment({
        params: { orgId, paymentId: pay.id },
        body: { reason: "Returned by the bank" },
      }),
      403,
      "ROLE_NOT_ALLOWED",
    );
    const rev = await d(st.fd).reverseSupplierPayment({
      params: { orgId, paymentId: pay.id },
      body: { reason: "Returned by the bank" },
    });
    expect(rev.status).toBe("reversed");
    expect((await d(st.aud).getInvoice({ params: { orgId, invoiceId: first.id } })).status).toBe("approved");
    const dash = await d(st.fd).dashboard({ params: O(), query: {} });
    expect(dash.payables.accountsPayable.agrees).toBe(true);
    expect(dash.cost.ledger.agrees).toBe(true);
  });

  it("role refusals: what each role may not do", async () => {
    await refused(d(st.viewer).listProjects({ params: O() }), 403, "ROLE_NOT_ALLOWED");
    await refused(d(st.ag1).createProject({ params: O(), body: { name: "Agent Project" } }), 403, "ROLE_NOT_ALLOWED");
    await refused(d(st.ag1).dashboard({ params: O(), query: {} }), 403, "ROLE_NOT_ALLOWED");
    await refused(
      d(st.pm).createBuyer({ params: O(), body: { name: "PM Buyer", phone: "+254 700 999 888" } }),
      403,
      "ROLE_NOT_ALLOWED",
    );
    await refused(d(st.proc).listBuyers({ params: O(), query: {} }), 403, "ROLE_NOT_ALLOWED");
    await refused(d(st.aud).createProject({ params: O(), body: { name: "Audit" } }), 403, "ROLE_NOT_ALLOWED");
    await refused(d(st.sm).updateSettings({ params: O(), body: { reservationDays: 30 } }), 403, "ROLE_NOT_ALLOWED");
    await refused(d(st.ap).executePaymentRun({ params: { orgId, runId: "x" } }), 403, "ROLE_NOT_ALLOWED");
    await refused(d(st.treasury).preparePaymentRun({ params: O(), body: {} }), 403, "ROLE_NOT_ALLOWED");
    await refused(d(st.acct).billInstalments({ params: O(), body: { asOf: "2027-01-01" } }), 400); // never in advance
    // limits only for roles that may approve
    await refused(
      d(st.ceo).updateSettings({
        params: O(),
        body: { limits: [{ kind: "invoice", role: "sales_agent", limitMinor: 1 }] },
      }),
      400,
    );
    expect((await d(st.aud).dashboard({ params: O(), query: {} })).currency).toBe("KES");
  });

  it("another organisation's records do not exist for you", async () => {
    const other = await devOrg(S, "Other Developer Ltd");
    const them = other.staff;
    const [anyBuyer] = await S.sql("SELECT id FROM dev_contacts WHERE org_id = $1 LIMIT 1", [orgId]);
    const [anyContract] = await S.sql("SELECT id FROM dev_contracts WHERE org_id = $1 AND status = 'active' LIMIT 1", [
      orgId,
    ]);
    const [anyInvoice] = await S.sql("SELECT id FROM dev_supplier_invoices WHERE org_id = $1 LIMIT 1", [orgId]);
    const [anyReport] = await S.sql("SELECT id FROM dev_payment_reports WHERE org_id = $1 LIMIT 1", [orgId]);
    // their own organisation, our ids
    const O2 = { orgId: other.orgId };
    await refused(d(them.ceo).getProject({ params: { ...O2, projectId } }), 404);
    await refused(d(them.ceo).getBuyer({ params: { ...O2, buyerId: anyBuyer.id } }), 404);
    await refused(d(them.ceo).contractStatement({ params: { ...O2, contractId: anyContract.id }, query: {} }), 404);
    await refused(d(them.ceo).getInvoice({ params: { ...O2, invoiceId: anyInvoice.id } }), 404);
    await refused(
      d(them.fd).verifyPayment({ params: { ...O2, reportId: anyReport.id }, body: { approve: true } }),
      404,
    );
    await refused(
      d(them.sm).createOffer({
        params: O2,
        body: { buyerId: anyBuyer.id, unitId: units[6]!.id, priceMinor: 1, plan: PLAN_CASH },
      }),
      404,
    );
    // our organisation: they are not members
    await refused(d(them.ceo).listProjects({ params: O() }), 404);
    expect((await d(them.ceo).listProjects({ params: O2 })).projects).toEqual([]);
  });
});
