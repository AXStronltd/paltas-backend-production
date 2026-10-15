/*
 * A customer's self-service on their own subscriptions, using the shared entitlement rules for every decision:
 * what they may use, what a change costs, what they can buy, and when changes take effect.
 * Each call works on ONE product subscription; one product never activates or changes another.
 */
import { entitlements, SELLABLE_PRODUCTS, type Product } from "@paltas/contracts";
import type { AppContext } from "../../context.js";
import { fail } from "../../http/errors.js";
import { addDays } from "../../lib/dates.js";
import { newId } from "../../lib/ids.js";
import { toMinor } from "../../lib/money.js";
import type { OrgScope } from "../access/org-access.js";
import { recordAudit } from "../audit/audit.service.js";
import { loadCatalogue } from "../catalogue/catalogue.service.js";
import { ensureAccounts } from "../ledger/default-chart.js";
import { billingService, monthlyChargeMinor, toInvoice } from "./billing.service.js";
import { loadOrgRecord, resolveEntitlement, toEntitlementsView } from "./entitlement.service.js";

export function subscriptionsService(ctx: AppContext) {
  const { db, clock, config, products: registry } = ctx;
  const billing = billingService(ctx);
  const scopeShape = (s: OrgScope) => ({ orgId: s.orgId, product: s.product, actor: s.actor, en: s.entitlement });

  return {
    entitlements(s: OrgScope) {
      return toEntitlementsView(s.entitlement);
    },

    async summary(s: OrgScope) {
      const en = s.entitlement;
      const e = en.ent;
      const invoices = await db.rows<Parameters<typeof toInvoice>[0]>(
        "SELECT * FROM billing_invoices WHERE org_id = $1 AND product = $2 ORDER BY issued DESC, id DESC",
        [s.orgId, s.product],
      );
      const receipts = await db.rows<{
        id: string;
        invoice_id: string;
        amount_minor: number;
        currency: string;
        ref: string;
        manual: boolean;
        created_at: string;
      }>(
        `SELECT r.* FROM billing_receipts r JOIN billing_invoices i ON i.id = r.invoice_id
         WHERE r.org_id = $1 AND i.product = $2 ORDER BY r.created_at DESC`,
        [s.orgId, s.product],
      );
      const monthly = monthlyChargeMinor(en, clock.today());
      return {
        organisation: { id: en.org.id, name: en.org.name, currency: en.org.currency, products: en.products },
        product: s.product,
        productName: e.productName,
        plan: { id: e.planId, name: e.plan.name, tier: e.tier },
        status: e.status,
        usable: e.usable,
        trialEnds: e.trialEnds,
        nextBilling: e.nextBilling,
        modules: e.moduleState,
        essentials: e.essentials,
        alwaysWorks: e.floor,
        allowance: e.buildings,
        pending: e.pending,
        upgrades: e.upgrades,
        downgrades: e.downgrades,
        monthly: {
          ...monthly.charge,
          taxNote: monthly.taxNote,
          missingPrices: monthly.missing,
          priced: monthly.priced,
        },
        outstandingMinor: invoices
          .filter((i) => i.status !== "Paid" && i.status !== "Void")
          .reduce((a, i) => a + i.total_minor, 0),
        billingMode: config.billingMode,
        invoices: invoices.map(toInvoice),
        receipts: receipts.map((r) => ({
          id: r.id,
          invoiceId: r.invoice_id,
          amountMinor: r.amount_minor,
          currency: r.currency,
          ref: r.ref,
          manual: r.manual,
          createdAt: r.created_at,
        })),
      };
    },

    async listProducts(orgId: string) {
      const org = await loadOrgRecord(db, registry, orgId);
      if (!org) throw fail.notFound("Organisation not found");
      const cat = await loadCatalogue(db);
      return {
        products: SELLABLE_PRODUCTS.map((k) => {
          const v = entitlements.viewOf(cat, org, k, clock.today());
          const e = v ? entitlements.resolve(cat, v, clock.today()) : null;
          return {
            product: k,
            name: entitlements.PRODUCT_NAME[k] ?? k,
            subscribed: !!e,
            plan: e ? e.planId : null,
            status: e ? e.status : null,
            offer: e
              ? null
              : cat.plans
                  .filter((p) => p.products[0] === k && p.tier)
                  .map((p) => {
                    const price = entitlements.priceIn(p.base, org.currency);
                    return {
                      id: p.id,
                      tier: p.tier,
                      price: price
                        ? { amountMinor: toMinor(price.amount, price.ccy), currency: price.ccy, per: price.per }
                        : null,
                      trialDays: p.trialDays ?? 0,
                    };
                  }),
          };
        }),
      };
    },

    /** Add another product as a separate subscription: a trial, or awaiting payment of its first invoice. */
    async addProduct(s: OrgScope, product: Product, planId: string) {
      if (!(SELLABLE_PRODUCTS as readonly string[]).includes(product))
        throw fail.invalid("This product cannot be added yet");
      if (s.entitlement.products.includes(product))
        throw fail.conflict(`Your organisation already has ${entitlements.PRODUCT_NAME[product]}`);
      const cat = s.entitlement.catalogue;
      const pl = cat.plans.find((p) => p.id === planId);
      if (!pl || pl.products[0] !== product) throw fail.invalid(`Pick a ${entitlements.PRODUCT_NAME[product]} plan`);
      const price = entitlements.priceIn(pl.base, s.entitlement.org.currency);
      if (pl.tier === "Enterprise" || !price)
        throw fail.invalid("This plan is agreed with PALTAS — send an Enterprise enquiry", { contactSales: true });
      const today = clock.today();
      const trial = (pl.trialDays ?? 0) > 0;
      const simulated = config.billingMode === "simulated";
      return db.tx(async (t) => {
        await t.run(
          "INSERT INTO subscriptions (org_id, product, plan_id, status, trial_ends, anchor) VALUES ($1,$2,$3,$4,$5,$6)",
          [
            s.orgId,
            product,
            pl.id,
            trial ? "trial" : simulated ? "active" : "expired",
            trial ? addDays(today, pl.trialDays ?? 0) : null,
            !trial && simulated ? today : null,
          ],
        );
        await ensureAccounts(t, s.orgId, registry.accountsFor(product));
        let invoice = null;
        if (!trial) {
          const en = await resolveEntitlement(t, registry, today, s.orgId, product);
          if (!en) throw new Error("Subscription just created was not found");
          const out = await billing.order(
            t,
            { orgId: s.orgId, product, actor: s.actor, en },
            {
              kind: "product",
              what: `${pl.name} — first ${pl.frequency ?? "month"}`,
              amountMinor: toMinor(price.amount, price.ccy),
              planId: pl.id,
              taxPct: pl.taxPct ?? 0,
              note: "New product",
            },
          );
          invoice = out.invoice;
        }
        const status = trial ? "trial" : simulated ? "active" : "awaiting payment";
        await recordAudit(t, {
          actor: s.actor,
          orgId: s.orgId,
          action: "Product subscription added",
          target: product,
          detail: `${pl.id} · ${status} · existing products unchanged`,
        });
        return {
          product,
          plan: pl.id,
          status,
          trialEnds: trial ? addDays(today, pl.trialDays ?? 0) : null,
          invoice,
        } as const;
      });
    },

    async buyAddon(s: OrgScope, moduleKey: string) {
      const q = entitlements.canBuy(s.entitlement.catalogue, s.entitlement.view, moduleKey, clock.today());
      if (!q.ok) {
        if (q.included || q.owned) throw fail.conflict(q.why, { included: !!q.included });
        throw fail.invalid(q.why, { contactSales: !!q.contactSales, needs: q.needs ?? null });
      }
      return db.tx(async (t) => {
        const out = await billing.order(t, scopeShape(s), {
          kind: "addon",
          what: `${q.module.name} — first ${q.price.per || "month"}`,
          amountMinor: toMinor(q.price.amount, q.price.ccy),
          moduleKey: q.module.key,
          note: "Add-on",
        });
        await recordAudit(t, {
          actor: s.actor,
          orgId: s.orgId,
          action:
            config.billingMode === "simulated" ? "Add-on bought (simulated)" : "Add-on ordered — awaiting payment",
          target: q.module.key,
          detail: `${s.product} · ${q.price.ccy} ${q.total}`,
        });
        return out;
      });
    },

    async cancelAddon(s: OrgScope, key: string) {
      const e = s.entitlement.ent;
      const st = e.moduleState[key];
      if (!st) throw fail.notFound("Unknown module");
      if (st.source === "plan")
        throw fail.conflict("Included in your plan — it is not charged separately, so there is nothing to cancel");
      if (st.source === "organisation")
        throw fail.conflict(`Comes with your ${st.sharedFrom} subscription — manage it there`);
      if (st.source !== "addon") throw fail.invalid("Not on your subscription");
      if (st.cancelsOn) throw fail.conflict(`Already cancelled — ends on ${st.cancelsOn}`);
      const dependants = s.entitlement.catalogue.modules.filter(
        (m) =>
          m.dep.includes(key) &&
          e.moduleState[m.key]?.source === "addon" &&
          e.modules[m.key] &&
          !e.moduleState[m.key]?.cancelsOn,
      );
      if (dependants.length)
        throw fail.conflict(`Cancel ${dependants.map((m) => m.name).join(", ")} first — it needs this module`);
      const effective = e.nextBilling ?? clock.today();
      await db.tx(async (t) => {
        await t.run(
          "INSERT INTO subscription_pending (id, org_id, product, type, module_key, effective, created_by) VALUES ($1,$2,$3,'cancelAddon',$4,$5,$6)",
          [newId("pen"), s.orgId, s.product, key, effective, s.userId],
        );
        await recordAudit(t, {
          actor: s.actor,
          orgId: s.orgId,
          action: "Add-on cancelled",
          target: key,
          detail: `${s.product} · ends ${effective} — records stay readable`,
        });
      });
      return { effective };
    },

    async changePlan(s: OrgScope, planId: string) {
      const q = entitlements.canChangePlan(s.entitlement.catalogue, s.entitlement.view, planId, clock.today());
      if (!q.ok) throw fail.invalid(q.why, { contactSales: !!q.contactSales });
      if (!q.upgrade) {
        await db.tx(async (t) => {
          await t.run("DELETE FROM subscription_pending WHERE org_id = $1 AND product = $2 AND type = 'plan'", [
            s.orgId,
            s.product,
          ]);
          await t.run(
            "INSERT INTO subscription_pending (id, org_id, product, type, plan_id, effective, created_by) VALUES ($1,$2,$3,'plan',$4,$5,$6)",
            [newId("pen"), s.orgId, s.product, q.plan.id, q.effective, s.userId],
          );
          await recordAudit(t, {
            actor: s.actor,
            orgId: s.orgId,
            action: "Downgrade scheduled",
            target: q.plan.id,
            detail: `from ${q.effective}${q.readOnlyAfter.length ? " · read-only after: " + q.readOnlyAfter.join(", ") : ""}`,
          });
        });
        return { scheduled: true as const, effective: q.effective, readOnlyAfter: q.readOnlyAfter };
      }
      return db.tx(async (t) => {
        const out = await billing.order(t, scopeShape(s), {
          kind: "plan",
          what: `${q.plan.name} — first ${q.plan.frequency ?? "month"}`,
          amountMinor: toMinor(q.price.amount, q.price.ccy),
          planId: q.plan.id,
          taxPct: q.plan.taxPct ?? 0,
          note: "Plan change",
        });
        await recordAudit(t, {
          actor: s.actor,
          orgId: s.orgId,
          action: q.renew ? "Plan renewal ordered" : "Plan upgrade ordered",
          target: q.plan.id,
          detail: out.purchase.status,
        });
        return out;
      });
    },

    async buyAllowance(s: OrgScope) {
      const p = entitlements.priceIn(s.entitlement.ent.extraBuilding, s.entitlement.org.currency);
      if (!p)
        throw fail.invalid(`Your plan has no extra-allowance price in ${s.entitlement.org.currency} — ask PALTAS`, {
          contactSales: true,
        });
      return db.tx(async (t) => {
        const out = await billing.order(t, scopeShape(s), {
          kind: "allowance",
          what: "One extra allowance — first month",
          amountMinor: toMinor(p.amount, p.ccy),
          note: "Allowance",
        });
        await recordAudit(t, {
          actor: s.actor,
          orgId: s.orgId,
          action: "Extra allowance ordered",
          target: s.product,
          detail: out.purchase.status,
        });
        return out;
      });
    },

    async cancel(s: OrgScope, reason: string) {
      const e = s.entitlement.ent;
      if (e.pending.some((p) => p.type === "cancel")) throw fail.conflict("Already cancelled");
      const effective = e.status === "trial" ? (e.trialEnds ?? clock.today()) : (e.nextBilling ?? clock.today());
      await db.tx(async (t) => {
        await t.run(
          "INSERT INTO subscription_pending (id, org_id, product, type, effective, reason, created_by) VALUES ($1,$2,$3,'cancel',$4,$5,$6)",
          [newId("pen"), s.orgId, s.product, effective, reason, s.userId],
        );
        await recordAudit(t, {
          actor: s.actor,
          orgId: s.orgId,
          action: "Subscription cancellation scheduled",
          target: s.product,
          detail: `ends ${effective} · records kept, read-only afterwards · other products not affected`,
        });
      });
      return { effective, product: s.product };
    },

    async withdrawPending(s: OrgScope, pendingId: string) {
      await db.tx(async (t) => {
        const n = await t.run("DELETE FROM subscription_pending WHERE id = $1 AND org_id = $2 AND effective > $3", [
          pendingId,
          s.orgId,
          clock.today(),
        ]);
        if (!n) throw fail.notFound("Nothing scheduled with this id");
        await recordAudit(t, {
          actor: s.actor,
          orgId: s.orgId,
          action: "Scheduled change withdrawn",
          target: pendingId,
        });
      });
      return { ok: true as const };
    },

    async enterpriseEnquiry(s: OrgScope, note: string) {
      const id = newId("ent");
      await db.tx(async (t) => {
        await t.run("INSERT INTO enterprise_enquiries (id, org_id, note, created_by) VALUES ($1,$2,$3,$4)", [
          id,
          s.orgId,
          note,
          s.userId,
        ]);
        await recordAudit(t, {
          actor: s.actor,
          orgId: s.orgId,
          action: "Enterprise enquiry sent",
          target: id,
          detail: note,
        });
      });
      return { id, status: "New" as const };
    },

    billing,
  };
}

export type SubscriptionsService = ReturnType<typeof subscriptionsService>;
