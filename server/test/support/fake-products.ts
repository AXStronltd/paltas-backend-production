/*
 * Two tiny stand-in products, registered exactly like real products will be (ProductModule). They let the core's
 * rules be tested end to end — allowance, module gating, product isolation, product payment types, product ledger
 * accounts — before the real Property Management and Development modules exist. Test-only; never shipped.
 */
import { endpoint, z } from "@paltas/contracts";
import { requireAllowance } from "../../dist/core/access/org-access.js";
import { route } from "../../dist/http/route.js";
import type { ProductModule } from "../../dist/products/registry.js";

const Params = z.object({ orgId: z.string() });
const Named = z.object({ name: z.string().min(1) });
const Item = z.object({ id: z.string(), name: z.string() });

function fakeProduct(
  product: "property" | "developer",
  thing: "buildings" | "projects",
): ProductModule & { store: Map<string, { id: string; name: string }[]>; leads: Map<string, string[]> } {
  const store = new Map<string, { id: string; name: string }[]>();
  const leads = new Map<string, string[]>();
  const base = `/api/v1/orgs/:orgId/test-${product}`;
  const list = endpoint({
    id: `test.${product}.list`,
    method: "GET",
    path: `${base}/${thing}`,
    auth: "user",
    summary: "test",
    params: Params,
    response: z.array(Item),
  });
  const add = endpoint({
    id: `test.${product}.add`,
    method: "POST",
    path: `${base}/${thing}`,
    auth: "user",
    summary: "test",
    params: Params,
    body: Named,
    response: Item,
    status: 201,
  });
  const listLeads = endpoint({
    id: `test.${product}.leads`,
    method: "GET",
    path: `${base}/leads`,
    auth: "user",
    summary: "test",
    params: Params,
    response: z.array(z.string()),
  });
  const addLead = endpoint({
    id: `test.${product}.addLead`,
    method: "POST",
    path: `${base}/leads`,
    auth: "user",
    summary: "test",
    params: Params,
    body: Named,
    response: z.object({ ok: z.literal(true) }),
    status: 201,
  });
  return {
    product,
    store,
    leads,
    accounts:
      product === "property" ? [{ code: "1010", name: "Client bank account (test)", type: "asset", system: true }] : [],
    usage: async (_db, orgId) => (store.get(orgId) ?? []).length,
    paymentHandlers: {
      [`test.${product}.payment`]: async (_t, ev) => ({
        result: `Applied — test ${product} payment ${ev.amountMinor}`,
        orgId: String(ev.data?.orgId ?? ""),
        targetId: null,
      }),
    },
    routes: (_ctx, core) => [
      route(list, async (req) => {
        await core.access.scope(req.user, req.params.orgId, { capability: "org.read", products: [product] });
        return store.get(req.params.orgId) ?? [];
      }),
      route(add, async (req) => {
        const s = await core.access.scope(req.user, req.params.orgId, {
          capability: "members.manage",
          products: [product],
          write: true,
        });
        requireAllowance(s);
        const item = { id: `${thing}-${(store.get(s.orgId) ?? []).length + 1}`, name: req.body.name };
        store.set(s.orgId, [...(store.get(s.orgId) ?? []), item]);
        return item;
      }),
      route(listLeads, async (req) => {
        await core.access.scope(req.user, req.params.orgId, { capability: "org.read", products: [product] });
        return leads.get(req.params.orgId) ?? [];
      }),
      route(addLead, async (req) => {
        const s = await core.access.scope(req.user, req.params.orgId, {
          capability: "members.manage",
          products: [product],
          write: true,
          module: "crm",
        });
        leads.set(s.orgId, [...(leads.get(s.orgId) ?? []), req.body.name]);
        return { ok: true as const };
      }),
    ],
  };
}

export function fakeProducts() {
  const property = fakeProduct("property", "buildings");
  const developer = fakeProduct("developer", "projects");
  return { property, developer, modules: [property, developer] };
}
