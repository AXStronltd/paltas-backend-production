/*
 * A test Property Management organisation (PM-GROWTH, active) with a person in every PM role, and helpers to set up
 * a property with units, an owner and a management agreement, and a tenant. Amounts are KES minor units.
 */
import { randomBytes } from "node:crypto";
import type { Role } from "@paltas/contracts";
import { property } from "../../dist/products/property/index.js";
import { migrationSettings } from "./migration-fixtures.js";
import { startServer, type Person, type TestServer } from "./test-server.js";

export async function startPropertyServer(): Promise<TestServer> {
  return startServer({ products: [property], config: { migration: migrationSettings() } });
}

export const PM_ROLES = [
  "property_manager",
  "accountant",
  "finance_director",
  "leasing_agent",
  "maintenance_manager",
  "technician",
  "front_desk",
  "auditor",
  "viewer",
] as const satisfies readonly Role[];

export type PmStaff = Record<(typeof PM_ROLES)[number], Person>;

export async function pmOrg(S: TestServer, o: { plan?: string; name?: string } = {}) {
  const org = await S.newOrg({
    name: o.name ?? "Almas Property Management " + randomBytes(3).toString("hex"),
    product: "property",
    plan: o.plan ?? "PM-GROWTH",
    trial: false,
  });
  const staff = {} as PmStaff;
  for (const r of PM_ROLES) staff[r] = await S.addMember(org.orgId, org.admin.api, r);
  return { orgId: org.orgId, admin: org.admin, staff };
}

export interface Building {
  propertyId: string;
  units: Record<string, string>;
  ownerId: string;
  agreementId: string;
}

/** A property with units, its owner (a contact) and the owner's management agreement (fee 10 %, authority 20,000). */
export async function setUpBuilding(
  orgId: string,
  pm: Person,
  o: {
    name?: string;
    units?: string[];
    owner?: { name: string; email: string };
    feePct?: number;
    authorityMinor?: number;
    lateFee?: { enabled: boolean; pct: number; graceDays: number; minMinor: number; payee: "owner" | "agency" };
  } = {},
): Promise<Building> {
  const p = await pm.api.property.createProperty({
    params: { orgId },
    body: {
      name: o.name ?? "Almas Tower",
      address: "Parklands, Nairobi",
      kind: "residential",
      lateFee: o.lateFee ?? { enabled: true, pct: 5, graceDays: 7, minMinor: 50_000, payee: "owner" },
    },
  });
  const b = await pm.api.property.createBuilding({
    params: { orgId, propertyId: p.id },
    body: { name: "Tower A", floors: 20 },
  });
  const created = await pm.api.property.createUnits({
    params: { orgId, propertyId: p.id },
    body: {
      units: (o.units ?? ["A-101", "A-102", "A-103"]).map((unitNo, i) => ({
        unitNo,
        buildingId: b.id,
        floor: "1",
        unitType: "2 bedroom",
        bedrooms: 2,
        marketRentMinor: 6_500_000 + i * 100_000,
      })),
    },
  });
  const owner = await pm.api.contacts.createContact({
    params: { orgId },
    body: {
      name: o.owner?.name ?? "Peter Mwangi",
      email: o.owner?.email ?? `owner+${randomBytes(3).toString("hex")}@example.com`,
      types: ["owner"],
    },
  });
  const ag = await pm.api.property.createAgreement({
    params: { orgId },
    body: {
      propertyId: p.id,
      ownerId: owner.contact.id,
      feePct: o.feePct ?? 10,
      authorityMinor: o.authorityMinor ?? 2_000_000,
      payoutDay: 10,
      startDate: "2026-01-01",
    },
  });
  return {
    propertyId: p.id,
    units: Object.fromEntries(created.units.map((u) => [u.unitNo, u.id])),
    ownerId: owner.contact.id,
    agreementId: ag.id,
  };
}

export async function newTenant(pm: Person, orgId: string, name: string, phone?: string) {
  const slug = name.toLowerCase().replace(/[^a-z]+/g, ".");
  const r = await pm.api.contacts.createContact({
    params: { orgId },
    body: {
      name,
      email: `${slug}+${randomBytes(2).toString("hex")}@example.com`,
      ...(phone ? { phone } : {}),
      types: ["tenant"],
      consent: { email: true, inapp: true, source: "Signed tenancy application" },
    },
  });
  return r.contact.id;
}

/** Balance of an account in the trial balance (debit − credit). */
export async function tbBalance(who: Person, orgId: string, code: string, asOf?: string) {
  const tb = await who.api.ledger.trialBalance({ params: { orgId }, query: asOf ? { asOf } : {} });
  const r = tb.rows.find((x) => x.code === code);
  return r ? r.debitMinor - r.creditMinor : 0;
}
