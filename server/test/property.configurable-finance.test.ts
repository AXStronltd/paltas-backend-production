import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { auditExport, verifyAuditExport } from "../dist/core/audit/integrity.js";
import { startPropertyServer, pmOrg, setUpBuilding, newTenant } from "./support/property-fixture.js";
import { refused, type TestServer } from "./support/test-server.js";
describe("portable audit integrity", () => {
  it("hashes every nested field and is independent of object key order", () => {
    const a = auditExport("org", [{ id: "1", payload: { nested: { a: 1, b: 2 }, list: [{ z: 3 }] } }]);
    const b = auditExport("org", [{ payload: { list: [{ z: 3 }], nested: { b: 2, a: 1 } }, id: "1" }]);
    expect(a.root).toBe(b.root);
    expect(verifyAuditExport(a, a.root)).toBe(true);
    const modified = structuredClone(a);
    (modified.records[0]!.entry.payload as { nested: { a: number } }).nested.a = 9;
    expect(verifyAuditExport(modified, a.root)).toBe(false);
    expect(
      verifyAuditExport(
        auditExport(
          "other",
          a.records.map((r) => r.entry),
        ),
        a.root,
      ),
    ).toBe(false);
    expect(verifyAuditExport({ ...a, records: [] }, a.root)).toBe(false);
    expect(verifyAuditExport(a, "bad")).toBe(false);
  });
  it("binds order, coverage and count; rejects unsupported values", () => {
    const a = auditExport("org", [{ id: "1" }, { id: "2" }]);
    expect(verifyAuditExport({ ...a, records: [...a.records].reverse() }, a.root)).toBe(false);
    expect(verifyAuditExport({ ...a, header: { ...a.header, count: 3 } }, a.root)).toBe(false);
    expect(() => auditExport("org", [{ amount: NaN }])).toThrow();
  });
});
describe("configurable tariffs and expense categories reuse property accounting", () => {
  let S: TestServer, X: Awaited<ReturnType<typeof pmOrg>>, B: Awaited<ReturnType<typeof setUpBuilding>>, water: string;
  const O = () => ({ orgId: X.orgId });
  beforeAll(async () => {
    S = await startPropertyServer();
    S.setToday("2026-10-24");
    X = await pmOrg(S);
    B = await setUpBuilding(X.orgId, X.staff.property_manager, { units: ["A-101", "A-102"] });
    water = (
      await X.staff.property_manager.api.property.createChargeType({
        params: O(),
        body: { code: "WATER", name: "Metered water", payee: "owner", metered: true, unitName: "m3", rateMinor: 150 },
      })
    ).id;
    for (const unitId of Object.values(B.units)) {
      const tenantId = await newTenant(X.staff.property_manager, X.orgId, "Tenant " + unitId);
      const lease = await X.staff.property_manager.api.property.createLease({
        params: O(),
        body: {
          unitId,
          tenantId,
          startDate: "2026-10-01",
          rentMinor: 100000,
          depositMinor: 0,
          charges: [{ chargeTypeId: water, amountMinor: null }],
        },
      });
      await X.staff.property_manager.api.property.activateLease({
        params: { ...O(), leaseId: lease.id },
        body: { signedOn: "2026-10-01" },
      });
    }
  });
  afterAll(async () => {
    if (S) await S.close();
  });
  const tariff = (unitId: string | null, period = "2026-10") => ({
    unitId,
    effectivePeriod: period,
    tiers: [
      { upTo: "10", rateMinor: 100 },
      { upTo: null, rateMinor: 200 },
    ],
    fixedMinor: 50,
    meterSerial: unitId ? "METER-102" : "",
    reason: "Reviewed configured water tariff",
  });
  it("validates cumulative bands, authorisation and duplicate schedules", async () => {
    const p = { ...O(), chargeTypeId: water };
    await refused(
      X.staff.property_manager.api.property.createUtilityTariff({
        params: p,
        body: {
          ...tariff(null),
          tiers: [
            { upTo: "10", rateMinor: 100 },
            { upTo: "5", rateMinor: 100 },
          ],
        },
      }),
      400,
    );
    await refused(X.staff.auditor.api.property.createUtilityTariff({ params: p, body: tariff(null) }), 403);
    await X.staff.property_manager.api.property.createUtilityTariff({ params: p, body: tariff(null) });
    await refused(X.staff.property_manager.api.property.createUtilityTariff({ params: p, body: tariff(null) }), 409);
    await X.staff.property_manager.api.property.createUtilityTariff({
      params: p,
      body: { ...tariff(B.units["A-102"]!), tiers: [{ upTo: null, rateMinor: 300 }], fixedMinor: 100 },
    });
    const other = await pmOrg(S);
    await refused(
      other.admin.api.property.listUtilityTariffs({ params: { orgId: other.orgId, chargeTypeId: water } }),
      404,
    );
    await refused(
      X.staff.property_manager.api.property.createUtilityTariff({
        params: p,
        body: tariff("other-organisation-unit", "2026-11"),
      }),
      404,
    );
  });
  it("limits delegated configuration to assigned properties and refuses global changes", async () => {
    const manager = await S.addMember(X.orgId, X.admin.api, "main_manager");
    await S.sql(
      "INSERT INTO main_manager_grants(org_id,user_id,product,capabilities,property_ids,updated_by) VALUES($1,$2,'property',ARRAY['property.setup','property.read','audit.read'],ARRAY[$3]::text[],$4)",
      [X.orgId, manager.userId, B.propertyId, X.admin.userId],
    );
    const params = { ...O(), chargeTypeId: water };
    await refused(manager.api.property.createUtilityTariff({ params, body: tariff(null, "2026-12") }), 403);
    await refused(
      manager.api.property.createExpenseCategory({
        params: O(),
        body: { name: "Not global", baseCategory: "other", taxCode: "", active: true },
      }),
      403,
    );
    await refused(manager.api.property.exportAuditIntegrity({ params: O() }), 403);
    const p = await X.admin.api.property.createProperty({ params: O(), body: { name: "Other assigned scope" } });
    const u = (
      await X.admin.api.property.createUnits({
        params: { ...O(), propertyId: p.id },
        body: { units: [{ unitNo: "PRIVATE-01" }] },
      })
    ).units[0]!;
    await X.admin.api.property.createUtilityTariff({ params, body: tariff(u.id, "2026-12") });
    await refused(manager.api.property.createUtilityTariff({ params, body: tariff(u.id, "2027-01") }), 404);
    const visible = await manager.api.property.listUtilityTariffs({ params });
    expect(visible.tariffs.some((t) => t.unitId === u.id)).toBe(false);
    await manager.api.property.createUtilityTariff({ params, body: tariff(B.units["A-101"]!, "2026-12") });
    await S.sql("UPDATE main_manager_grants SET enabled=false WHERE org_id=$1 AND user_id=$2", [
      X.orgId,
      manager.userId,
    ]);
    await refused(manager.api.property.listUtilityTariffs({ params }), 403);
  });
  it("requires readings, invoices exact tiered amounts and preserves pricing snapshots", async () => {
    const a = X.staff.property_manager.api.property;
    await refused(
      a.runBilling({ params: O(), body: { propertyId: B.propertyId, period: "2026-10", kind: "charges" } }),
      409,
    );
    await a.recordMeterReadings({
      params: O(),
      body: {
        period: "2026-10",
        readings: Object.values(B.units).map((unitId) => ({
          unitId,
          chargeTypeId: water,
          previous: 100,
          current: 112.5,
        })),
      },
    });
    const r = await a.runBilling({
      params: O(),
      body: { propertyId: B.propertyId, period: "2026-10", kind: "charges" },
    });
    expect(r.created.map((i) => i.amountMinor).sort((a, b) => a - b)).toEqual([1550, 3850]);
    expect(r.created.every((i) => i.lines[0]?.pricingSnapshot?.currency === "KES")).toBe(true);
    expect(r.created.find((i) => i.unitId === B.units["A-102"])!.lines[0]!.pricingSnapshot).toMatchObject({
      meterSerial: "METER-102",
      fixedMinor: 100,
      variableMinor: 3750,
    });
    expect(
      (await a.runBilling({ params: O(), body: { propertyId: B.propertyId, period: "2026-10", kind: "charges" } }))
        .created,
    ).toHaveLength(0);
    await refused(
      a.createUtilityTariff({ params: { ...O(), chargeTypeId: water }, body: tariff(null, "2026-09") }),
      409,
    );
    const stored = await S.sql("SELECT pricing_snapshot FROM pm_invoice_lines WHERE org_id=$1", [X.orgId]);
    expect(stored.filter((r) => r.pricing_snapshot)).toHaveLength(2);
    await expect(S.sql("UPDATE pm_utility_tariffs SET fixed_minor=0 WHERE org_id=$1", [X.orgId])).rejects.toBeTruthy();
  });
  it("rolls the entire billing run back when usage exceeds a finite tariff", async () => {
    S.setToday("2026-11-24");
    const a = X.staff.property_manager.api.property;
    await a.createUtilityTariff({
      params: { ...O(), chargeTypeId: water },
      body: { ...tariff(null, "2026-11"), tiers: [{ upTo: "1", rateMinor: 100 }] },
    });
    await a.recordMeterReadings({
      params: O(),
      body: {
        period: "2026-11",
        readings: Object.values(B.units).map((unitId) => ({
          unitId,
          chargeTypeId: water,
          previous: 112.5,
          current: 115,
        })),
      },
    });
    await refused(
      a.runBilling({ params: O(), body: { propertyId: B.propertyId, period: "2026-11", kind: "charges" } }),
      400,
    );
    expect(await S.sql("SELECT id FROM pm_invoices WHERE org_id=$1 AND period='2026-11'", [X.orgId])).toHaveLength(0);
    expect(await S.sql("SELECT id FROM pm_billing_runs WHERE org_id=$1 AND period='2026-11'", [X.orgId])).toHaveLength(
      0,
    );
    S.setToday("2026-10-24");
  });
  it("supports repeated category edits and deactivation; bills keep snapshots and existing approvals", async () => {
    const a = X.admin.api.property;
    let c = await a.createExpenseCategory({
      params: O(),
      body: { name: "Lift servicing", baseCategory: "repairs", taxCode: "Reviewed reference only", active: true },
    });
    const supplier = (
      await X.admin.api.contacts.createContact({ params: O(), body: { name: "Lift supplier", types: ["supplier"] } })
    ).contact.id;
    const bill = await a.submitBill({
      params: O(),
      body: {
        supplierId: supplier,
        supplierInvoiceNo: "LIFT-001",
        description: "Lift service",
        billDate: "2026-10-20",
        amountMinor: 12345,
        recoverFrom: "company",
        customCategoryId: c.id,
      },
    });
    expect(bill).toMatchObject({
      status: "submitted",
      customCategoryName: "Lift servicing",
      expenseCategory: "repairs",
      expenseAccount: "5650",
    });
    c = await a.updateExpenseCategory({
      params: { ...O(), categoryId: c.id },
      body: {
        taxCode: c.taxCode,
        active: c.active,
        name: "Lift maintenance",
        baseCategory: "other",
        expectedVersion: c.version,
        reason: "Updated template classification",
      },
    });
    await refused(
      a.updateExpenseCategory({
        params: { ...O(), categoryId: c.id },
        body: {
          name: c.name,
          baseCategory: c.baseCategory,
          taxCode: c.taxCode,
          active: true,
          expectedVersion: 1,
          reason: "Stale update attempt",
        },
      }),
      409,
    );
    c = await a.updateExpenseCategory({
      params: { ...O(), categoryId: c.id },
      body: {
        name: c.name,
        baseCategory: c.baseCategory,
        taxCode: c.taxCode,
        active: false,
        expectedVersion: c.version,
        reason: "Pause new category use",
      },
    });
    expect((await a.listBills({ params: O() })).bills.find((b) => b.id === bill.id)).toMatchObject({
      customCategoryName: "Lift servicing",
      expenseAccount: "5650",
    });
    await refused(
      a.submitBill({
        params: O(),
        body: {
          supplierId: supplier,
          supplierInvoiceNo: "LIFT-002",
          description: "Next service",
          billDate: "2026-10-20",
          amountMinor: 22222,
          recoverFrom: "company",
          customCategoryId: c.id,
        },
      }),
      409,
    );
    const edited = await a.editBill({
      params: { ...O(), billId: bill.id },
      body: {
        description: "Corrected lift service",
        amountMinor: 12000,
        dueDate: null,
        expenseCategory: "other",
        customCategoryId: c.id,
        expectedVersion: bill.version,
        reason: "Corrected reviewed amount",
      },
    });
    expect(edited).toMatchObject({ customCategoryName: "Lift servicing", expenseAccount: "5650" });
    await refused(a.approveBill({ params: { ...O(), billId: bill.id } }), 403);
    c = await a.updateExpenseCategory({
      params: { ...O(), categoryId: c.id },
      body: {
        name: c.name,
        baseCategory: c.baseCategory,
        taxCode: c.taxCode,
        active: true,
        expectedVersion: c.version,
        reason: "Restore reviewed category",
      },
    });
    expect(c.active).toBe(true);
    const other = await pmOrg(S);
    await refused(
      other.admin.api.property.updateExpenseCategory({
        params: { orgId: other.orgId, categoryId: c.id },
        body: {
          name: "No access",
          baseCategory: "other",
          taxCode: "",
          active: true,
          expectedVersion: c.version,
          reason: "Not authorised owner",
        },
      }),
      404,
    );
  });
  it("bills only configured fixed surcharges when consumption is zero", async () => {
    S.setToday("2026-12-24");
    const a = X.staff.property_manager.api.property;
    await a.recordMeterReadings({
      params: O(),
      body: {
        period: "2026-12",
        readings: Object.values(B.units).map((unitId) => ({
          unitId,
          chargeTypeId: water,
          previous: 115,
          current: 115,
        })),
      },
    });
    const r = await a.runBilling({
      params: O(),
      body: { propertyId: B.propertyId, period: "2026-12", kind: "charges" },
    });
    expect(r.created.map((i) => i.amountMinor).sort((a, b) => a - b)).toEqual([50, 100]);
    expect(r.created.every((i) => i.lines[0]?.pricingSnapshot?.variableMinor === 0)).toBe(true);
  });
  it("exports only the authorised organisation audit entries with a verifiable root", async () => {
    const r = await X.admin.api.property.exportAuditIntegrity({ params: O() });
    expect(verifyAuditExport(r.export, r.fingerprint)).toBe(true);
    expect(
      (r.export as { records: { entry: { orgId: string } }[] }).records.every((x) => x.entry.orgId === X.orgId),
    ).toBe(true);
  });
});
