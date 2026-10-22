import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pmOrg, startPropertyServer, newTenant } from "./support/property-fixture.js";
import { refused, type TestServer, type Person } from "./support/test-server.js";
describe("ownership → management authority → historical lease → explicit rent", () => {
  let S: TestServer,
    orgId: string,
    admin: Person,
    pm: Person,
    propertyId: string,
    unitId: string,
    tenantId: string,
    ownerId: string,
    ownId: string,
    authorityId: string,
    leaseId: string;
  beforeAll(async () => {
    S = await startPropertyServer();
    S.setToday("2026-10-22");
    const o = await pmOrg(S);
    orgId = o.orgId;
    admin = o.admin;
    pm = o.staff.property_manager;
    propertyId = (
      await pm.api.property.createProperty({ params: { orgId }, body: { name: "Synthetic ownership tower" } })
    ).id;
    unitId = (
      await pm.api.property.createUnits({
        params: { orgId, propertyId },
        body: { units: [{ unitNo: "103 E", floor: "1" }] },
      })
    ).units[0]!.id;
    tenantId = await newTenant(pm, orgId, "Separate Tenant");
    ownerId = (
      await pm.api.contacts.createContact({
        params: { orgId },
        body: { name: "Legal Owner Company", types: ["owner"] },
      })
    ).contact.id;
    leaseId = (
      await pm.api.property.createLease({
        params: { orgId },
        body: {
          unitId,
          tenantId,
          startDate: "2025-02-24",
          rentMinor: 9_000_000,
          depositMinor: 9_000_000,
          depositMode: "collect",
          dueDay: 5,
        },
      })
    ).id;
  });
  afterAll(() => S.close());
  it("blocks absent authority with a scoped correction action and no financial mutation", async () => {
    const e = await refused(
      pm.api.property.activateLease({ params: { orgId, leaseId }, body: { signedOn: "2026-10-22" } }),
      409,
    );
    expect(e.details.correction).toMatchObject({ action: "complete_ownership", propertyId, unitId, tenantId, leaseId });
    expect(await S.sql("SELECT id FROM pm_invoices WHERE org_id=$1", [orgId])).toHaveLength(0);
  });
  it("refuses legacy unsigned authority creation without an ownership record", async () => {
    const e = await refused(
      pm.api.property.createAgreement({
        params: { orgId },
        body: { propertyId, ownerId, feePct: 10, authorityMinor: 0, startDate: "2026-10-01" },
      }),
      400,
    );
    expect(e.message).toMatch(/Complete ownership first/);
    expect(await S.sql("SELECT id FROM pm_agreements WHERE org_id=$1", [orgId])).toHaveLength(0);
  });
  it("records ownership independently; verification cannot be self-inferred by a property manager", async () => {
    const r = await pm.api.property.createOwnership({
      params: { orgId },
      body: { propertyId, ownerId, ownerType: "company", evidenceRef: "Synthetic company title document" },
    });
    const x = r.ownerships[0]!;
    ownId = x.id;
    expect(x.status).toBe("pending");
    expect(x.ownerName).toBe("Legal Owner Company");
    expect(await S.sql("SELECT id FROM pm_agreements WHERE org_id=$1", [orgId])).toHaveLength(0);
    await refused(
      pm.api.property.verifyOwnership({ params: { orgId, ownershipId: ownId }, body: { confirm: "VERIFIED" } }),
      403,
    );
    expect(
      (
        await admin.api.property.verifyOwnership({
          params: { orgId, ownershipId: ownId },
          body: { confirm: "VERIFIED" },
        })
      ).status,
    ).toBe("verified");
  });
  it("saves owner-managed authority as draft, requiring explicit administrator approval without a third-party contract", async () => {
    const a = await pm.api.property.createAgreement({
      params: { orgId },
      body: {
        propertyId,
        ownerId,
        ownershipId: ownId,
        managementModel: "owner_managed",
        feePct: 0,
        authorityMinor: 0,
        startDate: "2026-10-01",
      },
    });
    authorityId = a.id;
    expect(a.status).toBe("draft");
    await refused(pm.api.property.activateLease({ params: { orgId, leaseId }, body: { signedOn: "2026-10-22" } }), 409);
    await refused(
      pm.api.property.activateAgreement({ params: { orgId, agreementId: authorityId }, body: { confirm: "ACTIVATE" } }),
      403,
    );
    const active = await admin.api.property.activateAgreement({
      params: { orgId, agreementId: authorityId },
      body: { confirm: "ACTIVATE" },
    });
    expect(active.status).toBe("active");
    expect(active.signedOn).toBeNull();
  });
  it("historical preview rolls back occupancy, deposit, invoices, journals and audit entries", async () => {
    const before = (await S.sql("SELECT count(*)::int n FROM audit_log WHERE org_id=$1", [orgId]))[0]!.n;
    const p = await pm.api.property.previewLeaseActivation({
      params: { orgId, leaseId },
      body: { signedOn: "2025-02-20", billingMode: "historical", billFirstRent: false },
    });
    expect(p).toMatchObject({ rentMinor: 0, depositMinor: 0, period: null });
    expect((await pm.api.property.getLease({ params: { orgId, leaseId } })).lease.status).toBe("draft");
    expect(await S.sql("SELECT id FROM pm_invoices WHERE org_id=$1", [orgId])).toHaveLength(0);
    expect(await S.sql("SELECT id FROM journal_entries WHERE org_id=$1", [orgId])).toHaveLength(0);
    expect((await S.sql("SELECT count(*)::int n FROM audit_log WHERE org_id=$1", [orgId]))[0]!.n).toBe(before);
  });
  it("refuses implied backdated rent and confirms only a selected unpaid period", async () => {
    await refused(
      pm.api.property.activateLease({
        params: { orgId, leaseId },
        body: { signedOn: "2025-02-20", billFirstRent: true },
      }),
      400,
    );
    const body = {
      signedOn: "2025-02-20",
      billingMode: "historical" as const,
      billFirstRent: true,
      firstRentPeriod: "2026-10",
    };
    const p = await pm.api.property.previewLeaseActivation({ params: { orgId, leaseId }, body });
    expect(p).toMatchObject({ rentMinor: 9_000_000, depositMinor: 0, period: "2026-10", issueDate: "2026-10-22" });
    await refused(
      pm.api.property.activateLease({ params: { orgId, leaseId }, body: { ...body, expectedRentMinor: 1 } }),
      409,
    );
    expect((await pm.api.property.getLease({ params: { orgId, leaseId } })).lease.status).toBe("draft");
    const a = await pm.api.property.activateLease({
      params: { orgId, leaseId },
      body: { ...body, expectedRentMinor: p.rentMinor, expectedDepositMinor: 0 },
    });
    expect(a.depositInvoice).toBeNull();
    expect(a.firstRentInvoice?.period).toBe("2026-10");
    expect(a.lease.signedOn).toBe("2025-02-20");
    expect(a.lease.startDate).toBe("2025-02-24");
    await refused(pm.api.property.activateLease({ params: { orgId, leaseId }, body }), 409);
    expect(await S.sql("SELECT id FROM pm_invoices WHERE lease_id=$1", [leaseId])).toHaveLength(1);
  });
  it("previews a new prorated rent and explicitly selected deposit without committing", async () => {
    const u = (
      await pm.api.property.createUnits({ params: { orgId, propertyId }, body: { units: [{ unitNo: "201 E" }] } })
    ).units[0]!;
    const l = await pm.api.property.createLease({
      params: { orgId },
      body: {
        unitId: u.id,
        tenantId,
        startDate: "2026-10-30",
        rentMinor: 9_000_000,
        depositMinor: 100_000,
        depositMode: "collect",
      },
    });
    const body = { signedOn: "2026-10-22", billFirstRent: true, billDeposit: true };
    const preview = await pm.api.property.previewLeaseActivation({ params: { orgId, leaseId: l.id }, body });
    expect(preview.rentMinor).toBe(Math.round((9_000_000 * 2) / 31));
    expect(preview.depositMinor).toBe(100_000);
    expect(await S.sql("SELECT id FROM pm_invoices WHERE lease_id=$1", [l.id])).toHaveLength(0);
    const active = await pm.api.property.activateLease({
      params: { orgId, leaseId: l.id },
      body: { ...body, expectedRentMinor: preview.rentMinor, expectedDepositMinor: preview.depositMinor },
    });
    expect(active.firstRentInvoice?.amountMinor).toBe(preview.rentMinor);
    expect(active.depositInvoice?.amountMinor).toBe(100_000);
  });
  it("third-party authority stays draft until signed evidence and effective dates are reviewed", async () => {
    const u = (
      await pm.api.property.createUnits({ params: { orgId, propertyId }, body: { units: [{ unitNo: "202 E" }] } })
    ).units[0]!;
    const a = await pm.api.property.createAgreement({
      params: { orgId },
      body: {
        propertyId,
        unitId: u.id,
        ownerId,
        ownershipId: ownId,
        managementModel: "third_party",
        feePct: 5,
        authorityMinor: 0,
        startDate: "2026-11-01",
      },
    });
    await refused(
      admin.api.property.activateAgreement({ params: { orgId, agreementId: a.id }, body: { confirm: "ACTIVATE" } }),
      400,
    );
    await pm.api.property.updateAgreement({
      params: { orgId, agreementId: a.id },
      body: {
        startDate: "2026-10-01",
        endDate: null,
        managementCompany: "Authorised Manager",
        evidenceRef: "Signed delegation reference",
        feePct: 5,
        authorityMinor: 0,
        payoutDay: 10,
      },
    });
    await refused(
      admin.api.property.activateAgreement({ params: { orgId, agreementId: a.id }, body: { confirm: "ACTIVATE" } }),
      400,
    );
    const active = await admin.api.property.activateAgreement({
      params: { orgId, agreementId: a.id },
      body: { confirm: "ACTIVATE", signedOn: "2026-09-30" },
    });
    expect(active.signedOn).toBe("2026-09-30");
  });
  it("unit-specific ownership cannot inherit another owner's whole-property mandate", async () => {
    const u = (
      await pm.api.property.createUnits({ params: { orgId, propertyId }, body: { units: [{ unitNo: "301 E" }] } })
    ).units[0]!;
    const otherOwner = (
      await pm.api.contacts.createContact({
        params: { orgId },
        body: { name: "Different Unit Owner", types: ["owner"] },
      })
    ).contact.id;
    const owned = (
      await pm.api.property.createOwnership({
        params: { orgId },
        body: {
          propertyId,
          unitIds: [u.id],
          ownerId: otherOwner,
          ownerType: "individual",
          evidenceRef: "Synthetic unit title",
        },
      })
    ).ownerships[0]!;
    await admin.api.property.verifyOwnership({
      params: { orgId, ownershipId: owned.id },
      body: { confirm: "VERIFIED" },
    });
    const l = await pm.api.property.createLease({
      params: { orgId },
      body: { unitId: u.id, tenantId, startDate: "2026-10-22", rentMinor: 100, depositMode: "none" },
    });
    await refused(
      pm.api.property.activateLease({ params: { orgId, leaseId: l.id }, body: { signedOn: "2026-10-22" } }),
      409,
    );
    const a = await pm.api.property.createAgreement({
      params: { orgId },
      body: {
        propertyId,
        unitId: u.id,
        ownerId: otherOwner,
        ownershipId: owned.id,
        managementModel: "owner_managed",
        feePct: 0,
        authorityMinor: 0,
        startDate: "2026-10-22",
      },
    });
    await admin.api.property.activateAgreement({ params: { orgId, agreementId: a.id }, body: { confirm: "ACTIVATE" } });
    expect(
      (
        await pm.api.property.activateLease({
          params: { orgId, leaseId: l.id },
          body: { signedOn: "2026-10-22", billDeposit: false },
        })
      ).lease.status,
    ).toBe("active");
  });
  it("ownership changes require verification again and never mutate existing invoices", async () => {
    await pm.api.property.updateOwnership({
      params: { orgId, ownershipId: ownId },
      body: { ownerId, evidenceRef: "Updated title evidence", note: "Corrected reference" },
    });
    const newUnit = (
      await pm.api.property.createUnits({ params: { orgId, propertyId }, body: { units: [{ unitNo: "104 E" }] } })
    ).units[0]!;
    const l = await pm.api.property.createLease({
      params: { orgId },
      body: { unitId: newUnit.id, tenantId, startDate: "2026-10-22", rentMinor: 100, depositMode: "none" },
    });
    await refused(
      pm.api.property.activateLease({ params: { orgId, leaseId: l.id }, body: { signedOn: "2026-10-22" } }),
      409,
    );
    expect(await S.sql("SELECT id FROM pm_invoices WHERE lease_id=$1", [leaseId])).toHaveLength(1);
  });
  it("refuses cross-organisation ownership and authority access", async () => {
    const other = await pmOrg(S);
    await refused(other.admin.api.property.listOwnerships({ params: { orgId } }), 404);
    await refused(
      other.admin.api.property.activateAgreement({
        params: { orgId, agreementId: authorityId },
        body: { confirm: "ACTIVATE" },
      }),
      404,
    );
  });
});
