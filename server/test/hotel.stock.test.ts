// Stock and purchasing: linen and amenities with par levels (housekeeping manages only those), issues, waste and
// counts at average cost, purchase orders approved by someone else, receipts, and the three-way match of supplier
// bills — the stock value always equal to inventory 1300 and goods received not invoiced cleared to zero.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { extHotel, type ExtHotel } from "./support/hotel-ext.js";
import { refused, type Person } from "./support/test-server.js";

describe("hotel stock and purchasing", () => {
  let X: ExtHotel;
  const api = (p: Person) => p.api.hotel;
  let towel: string;
  let soap: string;
  let po: string;

  beforeAll(async () => {
    X = await extHotel("Stock");
  });
  afterAll(() => X.S.close());

  const value = async () => (await api(X.st.cost_controller).listStock({ params: X.P, query: {} })).totalValueMinor;

  it("housekeeping manages linen and amenities with par levels — not food", async () => {
    const { st, P } = X;
    towel = (
      await api(st.housekeeping_supervisor).createStockItem({
        params: P,
        body: {
          code: "TOWEL",
          name: "Bath towel",
          category: "linen",
          unit: "piece",
          parLevel: 120,
          reorderQuantity: 60,
        },
      })
    ).id;
    await refused(
      api(st.housekeeping_supervisor).createStockItem({
        params: P,
        body: { code: "RICE", name: "Rice", category: "food", unit: "kg" },
      }),
      403,
    );
    await refused(
      api(st.housekeeping_attendant).createStockItem({
        params: P,
        body: { code: "SHEET", name: "Sheet", category: "linen", unit: "piece" },
      }),
      403,
    );
    await api(st.housekeeping_supervisor).receiveStock({
      params: { ...P, itemId: towel },
      body: { quantity: 100, totalCostMinor: 900_000, paidFrom: "payable", reference: "TEXTILE-1" },
    });
    const low = await api(st.housekeeping_supervisor).listStock({ params: P, query: { belowPar: "true" } });
    expect(low.items.map((i) => [i.code, i.quantity, i.unitCostMinor])).toEqual([["TOWEL", 100, 9_000]]);
    soap = (
      await api(st.housekeeping_supervisor).createStockItem({
        params: P,
        body: { code: "SOAP", name: "Guest soap", category: "amenity", unit: "piece", parLevel: 200 },
      })
    ).id;
  });

  it("issues, waste and counts move stock at average cost to rooms costs, equal to the ledger", async () => {
    const { st, P } = X;
    const before = await X.ledger("5100");
    const i = await api(st.housekeeping_supervisor).issueStock({
      params: { ...P, itemId: towel },
      body: { quantity: 10, note: "Floor 1 linen room" },
    });
    expect([i.move.kind, i.move.quantity, i.move.valueMinor]).toEqual(["issue", -10, -90_000]);
    await api(st.housekeeping_supervisor).issueStock({
      params: { ...P, itemId: towel },
      body: { quantity: 2, kind: "waste", note: "Stained beyond use" },
    });
    await refused(
      api(st.housekeeping_supervisor).issueStock({
        params: { ...P, itemId: towel },
        body: { quantity: 500, note: "Too many" },
      }),
      409,
    );
    const c = await api(st.housekeeping_supervisor).countStock({
      params: P,
      body: { counts: [{ itemId: towel, quantity: 85 }] },
    });
    // 3 short of 88 at 9,000 each
    expect(c.variances).toEqual([{ itemId: towel, name: "Bath towel", varianceQuantity: -3, valueMinor: -27_000 }]);
    expect((await X.ledger("5100")) - before).toBe(90_000 + 18_000 + 27_000);
    expect(await X.ledger("1300")).toBe(await value());
    const moves = await api(st.cost_controller).stockMoves({ params: { ...P, itemId: towel } });
    expect(moves.moves.map((m) => m.kind)).toEqual(["receipt", "issue", "waste", "count"]);
  });

  it("a purchase order is approved by someone other than who raised it (the database refuses it too)", async () => {
    const { st, P } = X;
    const o = await api(st.cost_controller).createPurchaseOrder({
      params: P,
      body: {
        supplier: "Coast Hotel Supplies",
        lines: [
          { stockItemId: soap, quantity: 300, unitCostMinor: 3_500 },
          { stockItemId: towel, quantity: 50, unitCostMinor: 9_000 },
        ],
      },
    });
    po = o.id;
    expect([o.number, o.status, o.totalMinor]).toEqual(["PO-00001", "draft", 1_500_000]);
    await refused(api(st.cost_controller).approvePurchaseOrder({ params: { ...P, poId: po } }), 403);
    await refused(api(st.ap_clerk).approvePurchaseOrder({ params: { ...P, poId: po } }), 403, "ROLE_NOT_ALLOWED");
    await refused(
      api(st.cost_controller).receivePurchaseOrder({ params: { ...P, poId: po }, body: { lines: [] } }),
      400,
    );
    await expect(
      X.S.sql("UPDATE hotel_purchase_orders SET approved_by = created_by, status = 'approved' WHERE id = $1", [po]),
    ).rejects.toThrow(/hotel_po_second_person/);
    const ok = await api(st.financial_controller).approvePurchaseOrder({ params: { ...P, poId: po } });
    expect([ok.status, ok.approvedBy]).toEqual(["approved", st.financial_controller.userId]);
  });

  it("three-way match: receipts post to goods received not invoiced; a matching bill clears it to payables", async () => {
    const { st, P } = X;
    await refused(
      api(st.ap_clerk).enterSupplierBill({
        params: { ...P, poId: po },
        body: { supplierRef: "INV-0", amountMinor: 100 },
      }),
      409,
    );
    const lines = (await api(st.cost_controller).listPurchaseOrders({ params: P, query: {} })).orders[0]!.lines;
    const soapLine = lines.find((l) => l.stockItemId === soap)!.id;
    const towelLine = lines.find((l) => l.stockItemId === towel)!.id;
    const r1 = await api(st.cost_controller).receivePurchaseOrder({
      params: { ...P, poId: po },
      body: {
        lines: [
          { poLineId: soapLine, quantity: 300 },
          { poLineId: towelLine, quantity: 30 },
        ],
      },
    });
    expect([r1.status, r1.receivedValueMinor]).toEqual(["approved", 1_050_000 + 270_000]);
    expect(await X.ledger("2010")).toBe(-1_320_000);
    await refused(
      api(st.cost_controller).receivePurchaseOrder({
        params: { ...P, poId: po },
        body: { lines: [{ poLineId: towelLine, quantity: 25 }] },
      }),
      409,
    );
    const ap = await X.ledger("2000");
    const vat = await X.ledger("2100");
    const b1 = await api(st.ap_clerk).enterSupplierBill({
      params: { ...P, poId: po },
      body: { supplierRef: "INV-1", amountMinor: 1_320_000, vatMinor: 211_200 },
    });
    expect(b1.bills.map((b) => [b.status, b.varianceMinor])).toEqual([["matched", 0]]);
    expect(await X.ledger("2010")).toBe(0);
    expect((await X.ledger("2000")) - ap).toBe(-1_531_200);
    expect((await X.ledger("2100")) - vat).toBe(211_200);
    await refused(
      api(st.ap_clerk).enterSupplierBill({
        params: { ...P, poId: po },
        body: { supplierRef: "INV-1", amountMinor: 5 },
      }),
      409,
    );
  });

  it("a bill that does not match is held; its variance is approved by someone other than who entered it", async () => {
    const { st, P } = X;
    const towelLine = (
      await api(st.cost_controller).listPurchaseOrders({ params: P, query: {} })
    ).orders[0]!.lines.find((l) => l.stockItemId === towel)!.id;
    const r2 = await api(st.cost_controller).receivePurchaseOrder({
      params: { ...P, poId: po },
      body: { lines: [{ poLineId: towelLine, quantity: 20 }] },
    });
    expect(r2.status).toBe("received");
    const held = await api(st.financial_controller).enterSupplierBill({
      params: { ...P, poId: po },
      body: { supplierRef: "INV-2", amountMinor: 190_000, vatMinor: 30_400 },
    });
    const bill = held.bills.find((b) => b.supplierRef === "INV-2")!;
    expect([bill.status, bill.expectedMinor, bill.varianceMinor]).toEqual(["held", 180_000, 10_000]);
    expect(await X.ledger("2010")).toBe(-180_000); // nothing posted while held
    await refused(
      api(st.ap_clerk).approveSupplierBill({ params: { ...P, billId: bill.id }, body: { reason: "Price rise" } }),
      403,
    );
    await refused(
      api(st.financial_controller).approveSupplierBill({
        params: { ...P, billId: bill.id },
        body: { reason: "Price rise" },
      }),
      403,
      "SEPARATION_OF_DUTIES",
    );
    await expect(
      X.S.sql("UPDATE hotel_supplier_bills SET approved_by = entered_by WHERE id = $1", [bill.id]),
    ).rejects.toThrow(/hotel_bill_second_person/);
    const costs = await X.ledger("5100");
    const done = await api(st.general_manager).approveSupplierBill({
      params: { ...P, billId: bill.id },
      body: { reason: "Supplier price rise accepted" },
    });
    expect(done.bills.find((b) => b.id === bill.id)!.status).toBe("approved");
    expect(await X.ledger("2010")).toBe(0);
    expect((await X.ledger("5100")) - costs).toBe(10_000); // the price variance, to the amenities' rooms costs
    const v = await value();
    expect(v).toBe(1_215_000 + 1_050_000);
    expect(await X.ledger("1300")).toBe(v);
  });

  it("another organisation cannot see this hotel's purchase orders or stock", async () => {
    const other = await X.S.newOrg({ name: "Rival Hotels", product: "hotel", plan: "HOTEL-PRO", trial: false });
    const p = await other.admin.api.hotel.createProperty({
      params: { orgId: other.orgId },
      body: { name: "Rival Inn", country: "Kenya", city: "Nairobi", tax: { vatPct: 16 } },
    });
    await refused(
      other.admin.api.hotel.stockMoves({ params: { orgId: other.orgId, propertyId: p.id, itemId: towel } }),
      404,
    );
    await refused(other.admin.api.hotel.listPurchaseOrders({ params: X.P, query: {} }), 404);
  });
});
