/*
 * A test developer: a Development organisation (DEV-PRO, active) with a person in every Development role of the
 * workspace's role switcher, and approval limits (KES minor units):
 *   requisitions  project manager 2M · procurement 5M · finance director 20M
 *   orders        procurement 5M · finance director 20M
 *   invoices, budget changes   finance director 20M
 *   payment runs  finance director 100M          (the organisation administrator — the CEO — has no limit)
 */
import { createHash, randomBytes } from "node:crypto";
import type { Role } from "@paltas/contracts";
import { development } from "../../dist/products/development/index.js";
import { startServer, type Person, type TestServer } from "./test-server.js";

export const M = (kes: number) => Math.round(kes * 100);

export async function startDevServer(config: Parameters<typeof startServer>[0] = {}): Promise<TestServer> {
  return startServer({ products: [development], ...config });
}

export const DEV_ROLES = {
  fd: "finance_director",
  acct: "accountant",
  pm: "project_manager",
  proc: "procurement_officer",
  ap: "ap_clerk",
  treasury: "treasury_officer",
  sm: "sales_manager",
  sm2: "sales_manager",
  ag1: "sales_agent",
  ag2: "sales_agent",
  aud: "auditor",
  viewer: "viewer",
} as const satisfies Record<string, Role>;

export type DevStaff = Record<keyof typeof DEV_ROLES, Person> & { ceo: Person };

export const LIMITS = [
  { kind: "requisition", role: "project_manager", limitMinor: M(2e6) },
  { kind: "requisition", role: "procurement_officer", limitMinor: M(5e6) },
  { kind: "requisition", role: "finance_director", limitMinor: M(20e6) },
  { kind: "purchase_order", role: "procurement_officer", limitMinor: M(5e6) },
  { kind: "purchase_order", role: "finance_director", limitMinor: M(20e6) },
  { kind: "invoice", role: "finance_director", limitMinor: M(20e6) },
  { kind: "budget_change", role: "finance_director", limitMinor: M(20e6) },
  { kind: "payment_run", role: "finance_director", limitMinor: M(100e6) },
] as const;

export async function devOrg(S: TestServer, name?: string) {
  const o = await S.newOrg({
    name: name ?? "Acacia Developments " + randomBytes(3).toString("hex"),
    product: "developer",
    plan: "DEV-PRO",
    trial: false,
  });
  const staff = { ceo: o.admin } as DevStaff;
  for (const [k, role] of Object.entries(DEV_ROLES))
    staff[k as keyof typeof DEV_ROLES] = await S.addMember(o.orgId, o.admin.api, role);
  await o.admin.api.development.updateSettings({ params: { orgId: o.orgId }, body: { limits: [...LIMITS] } });
  return { orgId: o.orgId, staff };
}

/** A document record (metadata) for evidence: a signed agreement, a certificate, an invoice … */
export async function doc(p: Person, orgId: string, filename: string, kind = "evidence") {
  const sha256 = createHash("sha256")
    .update(filename + randomBytes(4).toString("hex"))
    .digest("hex");
  return p.api.development.registerDocument({
    params: { orgId },
    body: { filename, sizeBytes: 12_345, sha256, contentType: "application/pdf", kind },
  });
}

/** A project with one block and units of 85 m² at KES 15,000,000. */
export async function buildProject(
  ceo: Person,
  orgId: string,
  o: { name?: string; units?: number; endDate?: string } = {},
) {
  const api = ceo.api.development;
  const p = await api.createProject({
    params: { orgId },
    body: {
      name: o.name ?? "Riverside Gardens",
      location: "Riverside Drive, Nairobi",
      startDate: "2025-09-01",
      endDate: o.endDate ?? "2027-06-30",
      status: "selling",
    },
  });
  const P = { orgId, projectId: p.id };
  const withBlock = await api.createBuilding({ params: P, body: { name: "Block A", floorsCount: 5 } });
  const blockId = withBlock.buildings[0]!.id;
  const { units } = await api.createUnits({
    params: P,
    body: {
      units: Array.from({ length: o.units ?? 4 }, (_, i) => ({
        unitNo: `A10${i + 1}`,
        buildingId: blockId,
        level: 1,
        type: "2 bed",
        bedrooms: 2,
        areaSqm: 85,
        listPriceMinor: M(15e6),
      })),
    },
  });
  return { projectId: p.id, blockId, units };
}

export const PLAN_10_50_40 = { depositBp: 1000, instalmentsBp: 5000, months: 12, completionBp: 4000 };
export const PLAN_CASH = { depositBp: 10_000, instalmentsBp: 0, months: 0, completionBp: 0 };
