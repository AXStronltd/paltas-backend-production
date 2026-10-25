import { beforeAll, afterAll, it, expect } from "vitest";
import { startPropertyServer, pmOrg, setUpBuilding, newTenant } from "./support/property-fixture.js";
import { refused, type TestServer, type Person } from "./support/test-server.js";
import type { property as P } from "@paltas/contracts";
let S: TestServer,
  admin: Person,
  orgId: string,
  propertyId: string,
  unitId: string,
  legacyUnit: string,
  water: string,
  leaseId: string,
  meter: P.UtilityMeter,
  reading: P.MeterReading;
const O = () => ({ orgId });
beforeAll(async () => {
  S = await startPropertyServer();
  S.setToday("2026-03-15");
  const o = await pmOrg(S);
  ({ orgId, admin } = o);
  const b = await setUpBuilding(orgId, admin, { units: ["101 E", "102 E"] });
  propertyId = b.propertyId;
  unitId = b.units["101 E"]!;
  legacyUnit = b.units["102 E"]!;
  const c = await admin.api.property.createChargeType({
    params: O(),
    body: { code: "WATER", name: "Water", payee: "owner", metered: true, rateMinor: 100, unitName: "m3" },
  });
  water = c.id;
  const tenant = await newTenant(admin, orgId, "Meter resident");
  const l = await admin.api.property.createLease({
    params: O(),
    body: { unitId, tenantId: tenant, startDate: "2026-01-01", rentMinor: 50000 },
  });
  leaseId = l.id;
  await admin.api.property.activateLease({
    params: { orgId, leaseId },
    body: { signedOn: "2026-01-01", billFirstRent: false },
  });
  await admin.api.property.setLeaseCharges({
    params: { orgId, leaseId },
    body: { charges: [{ chargeTypeId: water, amountMinor: null }] },
  });
});
afterAll(() => S.close());
it("preserves legacy readings, supports repeat corrections and stores immutable revisions without new financial postings", async () => {
  const a = admin.api.property;
  let r = (
    await a.recordMeterReadings({
      params: O(),
      body: { period: "2026-01", readings: [{ unitId: legacyUnit, chargeTypeId: water, previous: 10, current: 20 }] },
    })
  ).readings[0]!;
  expect(r).toMatchObject({ meterId: null, kind: "actual", version: 1, consumption: 10, billed: false });
  await refused(
    a.recordMeterReadings({
      params: O(),
      body: {
        period: r.period,
        readings: [{ unitId: legacyUnit, chargeTypeId: water, previous: 10, current: 21, reason: "Version missing" }],
      },
    }),
    409,
  );
  r = (
    await a.recordMeterReadings({
      params: O(),
      body: {
        period: r.period,
        readings: [
          {
            unitId: legacyUnit,
            chargeTypeId: water,
            previous: 10,
            current: 21,
            expectedVersion: r.version,
            reason: "Corrected transcribed display",
          },
        ],
      },
    })
  ).readings[0]!;
  r = (
    await a.recordMeterReadings({
      params: O(),
      body: {
        period: r.period,
        readings: [
          {
            unitId: legacyUnit,
            chargeTypeId: water,
            previous: 10,
            current: 21.5,
            expectedVersion: r.version,
            reason: "Verified photograph precision",
          },
        ],
      },
    })
  ).readings[0]!;
  const h = await a.meterReadingHistory({ params: { orgId, readingId: r.id } });
  expect(h.events).toHaveLength(3);
  expect(h.events[0]?.actorName).toBeTruthy();
  expect(h.events[0]?.snapshot.current).toBe(20);
  expect(h.reading.consumption).toBe(11.5);
  await expect(
    S.sql("UPDATE pm_meter_reading_events SET reason='tampered' WHERE reading_id=$1", [r.id]),
  ).rejects.toThrow();
  expect((await a.listInvoices({ params: O() })).invoices).toHaveLength(0);
});
it("registers a physical meter and checks opening readings, estimate evidence and versions", async () => {
  const a = admin.api.property;
  meter = await a.registerUtilityMeter({
    params: O(),
    body: {
      unitId,
      chargeTypeId: water,
      serial: "W-E-101-OLD",
      fromPeriod: "2026-01",
      opening: 10,
      reason: "Installed physical water meter",
    },
  });
  await refused(
    a.registerUtilityMeter({
      params: O(),
      body: {
        unitId,
        chargeTypeId: water,
        serial: "W-OVERLAP",
        fromPeriod: "2026-02",
        opening: 0,
        reason: "Must close old physical meter",
      },
    }),
    409,
  );
  await refused(
    a.recordMeterReadings({
      params: O(),
      body: { period: "2026-01", readings: [{ unitId, chargeTypeId: water, previous: 0, current: 20 }] },
    }),
    409,
  );
  await refused(
    a.recordMeterReadings({
      params: O(),
      body: {
        period: "2026-01",
        readings: [{ unitId, chargeTypeId: water, previous: 10, current: 20, kind: "estimated" }],
      },
    }),
    400,
  );
  reading = (
    await a.recordMeterReadings({
      params: O(),
      body: {
        period: "2026-01",
        readings: [
          {
            unitId,
            chargeTypeId: water,
            previous: 10,
            current: 20,
            kind: "estimated",
            reason: "Based on documented prior average",
          },
        ],
      },
    })
  ).readings[0]!;
  expect(reading).toMatchObject({ meterId: meter.id, meterSerial: meter.serial, version: 1, kind: "estimated" });
  await refused(
    a.recordMeterReadings({
      params: O(),
      body: {
        period: "2026-01",
        readings: [
          {
            unitId,
            chargeTypeId: water,
            previous: 10,
            current: 21,
            expectedVersion: 9,
            reason: "Stale display correction",
          },
        ],
      },
    }),
    409,
  );
});
it("requires explicit estimate approval and freezes source identity and values on issued invoices", async () => {
  const a = admin.api.property;
  await refused(a.runBilling({ params: O(), body: { propertyId, period: "2026-01", kind: "charges" } }), 409);
  expect((await a.listInvoices({ params: O() })).invoices).toHaveLength(0);
  const b = await a.runBilling({
    params: O(),
    body: { propertyId, period: "2026-01", kind: "charges", allowEstimatedReadings: true },
  });
  expect(b.created[0]?.amountMinor).toBe(1000);
  expect(b.created[0]?.lines[0]?.pricingSnapshot).toMatchObject({
    readingId: reading.id,
    readingVersion: 1,
    readingKind: "estimated",
    meterId: meter.id,
    meterSerial: meter.serial,
    estimatedApproved: true,
  });
  expect(b.created[0]?.lines[0]?.description).toContain("ESTIMATED");
  await refused(
    a.recordMeterReadings({
      params: O(),
      body: {
        period: reading.period,
        readings: [
          {
            unitId,
            chargeTypeId: water,
            previous: 10,
            current: 21,
            expectedVersion: reading.version,
            reason: "Cannot rewrite posted source",
          },
        ],
      },
    }),
    409,
  );
  await expect(S.sql("UPDATE pm_meter_readings SET current=21 WHERE id=$1", [reading.id])).rejects.toThrow();
  await expect(S.sql("DELETE FROM pm_meter_readings WHERE id=$1", [reading.id])).rejects.toThrow();
  expect((await a.meterReadingHistory({ params: { orgId, readingId: reading.id } })).reading.billed).toBe(true);
  expect(
    (
      await a.runBilling({
        params: O(),
        body: { propertyId, period: "2026-01", kind: "charges", allowEstimatedReadings: true },
      })
    ).created,
  ).toHaveLength(0);
});
it("closes on an actual final reading and replaces from the next month without treating a reset as negative consumption", async () => {
  const a = admin.api.property;
  await refused(
    a.retireUtilityMeter({
      params: { orgId, meterId: meter.id },
      body: {
        expectedVersion: meter.version,
        throughPeriod: "2026-01",
        closing: 20,
        reason: "Estimated closing is not verified",
      },
    }),
    409,
  );
  await refused(
    a.recordMeterReadings({
      params: O(),
      body: { period: "2026-02", readings: [{ unitId, chargeTypeId: water, previous: 19, current: 30 }] },
    }),
    409,
  );
  await a.recordMeterReadings({
    params: O(),
    body: { period: "2026-02", readings: [{ unitId, chargeTypeId: water, previous: 20, current: 30 }] },
  });
  meter = await a.retireUtilityMeter({
    params: { orgId, meterId: meter.id },
    body: {
      expectedVersion: meter.version,
      throughPeriod: "2026-02",
      closing: 30,
      reason: "Physical replacement after final reading",
    },
  });
  expect(meter.throughPeriod).toBe("2026-02");
  expect(meter.events).toHaveLength(2);
  await refused(
    a.recordMeterReadings({
      params: O(),
      body: { period: "2026-03", readings: [{ unitId, chargeTypeId: water, previous: 0, current: 3.5 }] },
    }),
    409,
  );
  const replacement = await a.registerUtilityMeter({
    params: O(),
    body: {
      unitId,
      chargeTypeId: water,
      serial: "W-E-101-NEW",
      fromPeriod: "2026-03",
      opening: 0,
      reason: "New meter commissioned after replacement",
    },
  });
  const r = await a.recordMeterReadings({
    params: O(),
    body: {
      period: "2026-03",
      readings: [{ unitId, chargeTypeId: water, previous: 0, current: 3.5, meterId: replacement.id }],
    },
  });
  expect(r.readings[0]?.consumption).toBe(3.5);
  const b = await a.runBilling({ params: O(), body: { propertyId, period: "2026-03", kind: "charges" } });
  expect(b.created[0]?.amountMinor).toBe(350);
  expect(b.created[0]?.lines[0]?.pricingSnapshot).toMatchObject({
    meterSerial: "W-E-101-NEW",
    readingKind: "actual",
    estimatedApproved: false,
  });
  const d = await a.dashboard({ params: O() });
  expect(Object.values(d.ledger).every((x) => x.agrees)).toBe(true);
});
it("protects scope, stable pagination, field precision and atomic batch rollback", async () => {
  const a = admin.api.property;
  const before = await a.listMeterReadings({ params: O(), query: { period: "2026-02" } });
  const old = before.readings.find((x) => x.unitId === unitId)!;
  await refused(
    a.recordMeterReadings({
      params: O(),
      body: {
        period: "2026-02",
        readings: [
          { unitId: legacyUnit, chargeTypeId: water, previous: 21.5, current: 25 },
          {
            unitId,
            chargeTypeId: water,
            previous: 20,
            current: 31,
            expectedVersion: old.version,
            reason: "Closed final value cannot be changed",
          },
        ],
      },
    }),
    409,
  );
  expect(
    (await a.listMeterReadings({ params: O(), query: { period: "2026-02" } })).readings.find(
      (x) => x.unitId === legacyUnit,
    ),
  ).toBeUndefined();
  await refused(
    a.recordMeterReadings({
      params: O(),
      body: {
        period: "2026-04",
        readings: [{ unitId: legacyUnit, chargeTypeId: water, previous: 25, current: 26.1234 }],
      },
    }),
    400,
  );
  const first = await a.listUtilityMeters({ params: O(), query: { limit: 1, offset: 0 } }),
    last = await a.listUtilityMeters({ params: O(), query: { limit: 1, offset: 1 } });
  expect(first.total).toBe(2);
  expect(last.total).toBe(2);
  expect(first.meters[0]?.id).not.toBe(last.meters[0]?.id);
  const other = await pmOrg(S);
  await refused(other.admin.api.property.meterReadingHistory({ params: { orgId, readingId: reading.id } }), 404);
  const manager = await S.addMember(orgId, admin.api, "main_manager");
  await admin.api.organisations.setManagerGrants({
    params: { orgId, userId: manager.userId },
    body: {
      grants: [
        {
          product: "property",
          capabilities: ["property.read", "property.leases.manage", "property.tenants.leaseEdit"],
          propertyIds: [],
          enabled: true,
        },
      ],
      reason: "No units assigned",
      confirm: "SAVE_PERMISSIONS",
    },
  });
  expect((await manager.api.property.listUtilityMeters({ params: O() })).meters).toHaveLength(0);
  await refused(manager.api.property.meterReadingHistory({ params: { orgId, readingId: reading.id } }), 404);
  await refused(
    manager.api.property.recordMeterReadings({
      params: O(),
      body: { period: "2026-02", readings: [{ unitId: legacyUnit, chargeTypeId: water, previous: 21.5, current: 25 }] },
    }),
    404,
  );
  await admin.api.organisations.setManagerGrants({
    params: { orgId, userId: manager.userId },
    body: {
      grants: [
        {
          product: "property",
          capabilities: ["property.read", "property.leases.manage", "property.tenants.leaseEdit"],
          propertyIds: [propertyId],
          enabled: true,
        },
      ],
      reason: "Assigned utility management",
      confirm: "SAVE_PERMISSIONS",
    },
  });
  expect((await manager.api.property.listUtilityMeters({ params: O(), query: { limit: 1, offset: 2 } })).total).toBe(2);
  expect(
    (await manager.api.property.listMeterReadings({ params: O(), query: { period: "2026-01" } })).readings,
  ).toHaveLength(2);
});
