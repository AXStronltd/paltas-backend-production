/* GENERATED FILE — do not edit. Source: paltas-backend-production contracts/src/entitlements/rules.ts
   Rebuild in the backend repository with: npm run browser:build (writes browser/), then copy to the front end's shared/
   PALTAS entitlement rules: ONE implementation shared by the browser workspaces (front end: shared/entitlements.js,
   inlined into platform.js by source/build.sh) and the PALTAS server, which imports the TypeScript source directly. */
(function (root) {
"use strict";
var __paltasBundle = (() => {
  var __defProp = Object.defineProperty;
  var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __hasOwnProp = Object.prototype.hasOwnProperty;
  var __export = (target, all) => {
    for (var name in all)
      __defProp(target, name, { get: all[name], enumerable: true });
  };
  var __copyProps = (to, from, except, desc) => {
    if (from && typeof from === "object" || typeof from === "function") {
      for (let key of __getOwnPropNames(from))
        if (!__hasOwnProp.call(to, key) && key !== except)
          __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
    }
    return to;
  };
  var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

  // contracts/dist/entitlements/rules.js
  var rules_exports = {};
  __export(rules_exports, {
    DEFAULT_TRIAL_POLICY: () => DEFAULT_TRIAL_POLICY,
    ESSENTIALS: () => ESSENTIALS,
    FLOOR: () => FLOOR,
    MODULE_NAME: () => MODULE_NAME,
    PRODUCT_NAME: () => PRODUCT_NAME,
    TIER_RANK: () => TIER_RANK,
    addDays: () => addDays,
    addMonths: () => addMonths,
    canBuy: () => canBuy,
    canChangePlan: () => canChangePlan,
    charges: () => charges,
    moduleName: () => moduleName,
    nextBilling: () => nextBilling,
    priceIn: () => priceIn,
    productOf: () => productOf,
    productsOf: () => productsOf,
    resolve: () => resolve,
    subOf: () => subOf,
    trialState: () => trialState,
    v: () => v,
    validateModule: () => validateModule,
    validatePlan: () => validatePlan,
    viewOf: () => viewOf
  });
  var v = 1;
  var ESSENTIALS = [
    ["auth", "Sign-in and identity"],
    ["access", "Roles and access control"],
    ["isolation", "Organisation isolation"],
    ["sec", "Security settings"],
    ["audit", "Audit trail"]
  ];
  var FLOOR = {
    property: [
      "Properties, units and tenants",
      "Leases",
      "Invoices and payment status",
      "Tenant identity and contact details",
      "Maintenance requests"
    ],
    developer: ["Projects and units", "Buyers and reservations", "Sales and payment-plan status", "Documents"],
    agency: ["Listings", "Contacts and enquiries"],
    hotel: ["Rooms and reservations"],
    security: ["Sites, guards and incidents"]
  };
  var TIER_RANK = { Standard: 1, Pro: 2, Enterprise: 3 };
  var DEFAULT_TRIAL_POLICY = {
    trialDays: 30,
    graceDays: 0,
    reminderDays: [10, 7, 3, 1],
    verifyWithinDays: 7,
    verifyLinkHours: 48,
    repeatWindowDays: 365,
    repeatMatch: ["email", "phone", "company"],
    secondProduct: "own_trial",
    atExpiry: "read_only",
    keepRecords: true,
    exportAllowed: true
  };
  var PRODUCT_NAME = {
    property: "Property Management",
    agents: "Agent & Host",
    agency: "Agent & Host",
    developer: "Real Estate Development",
    hotel: "Hotel",
    security: "Security Services"
  };
  var MODULE_NAME = {
    crm: "Advanced CRM and Marketing",
    maint: "Maintenance",
    finance: "Finance and Accounting",
    payments: "Payments and Banking",
    procurement: "Supplier and Procurement Management",
    intelligence: "Advanced Reports and Intelligence",
    docs: "Document Intelligence",
    automation: "Workflow Automation"
  };
  var rank = (tier) => tier ? TIER_RANK[tier] || 0 : 0;
  var r2 = (n) => Math.round(n * 100) / 100;
  function addDays(d, n) {
    const t = /* @__PURE__ */ new Date(d + "T00:00:00Z");
    t.setUTCDate(t.getUTCDate() + n);
    return t.toISOString().slice(0, 10);
  }
  function addMonths(d, n) {
    const t = /* @__PURE__ */ new Date(d + "T00:00:00Z");
    const day = t.getUTCDate();
    t.setUTCDate(1);
    t.setUTCMonth(t.getUTCMonth() + n);
    const last = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate();
    t.setUTCDate(Math.min(day, last));
    return t.toISOString().slice(0, 10);
  }
  var dayNumber = (d) => Math.round((/* @__PURE__ */ new Date(d + "T00:00:00Z")).getTime() / 864e5);
  function trialState(sub, today) {
    if (!sub || !sub.trialEnds || !(sub.status === "trial" || sub.status === "expired" && !sub.anchor))
      return null;
    const grace = sub.graceDays || 0;
    const graceEnds = addDays(sub.trialEnds, grace);
    const phase = sub.status === "expired" || graceEnds < today ? "expired" : sub.trialEnds < today ? "grace" : "trial";
    return {
      phase,
      trialEnds: sub.trialEnds,
      graceEnds,
      daysLeft: Math.max(0, dayNumber(sub.trialEnds) - dayNumber(today)),
      graceDaysLeft: phase === "expired" ? 0 : phase === "grace" ? dayNumber(graceEnds) - dayNumber(today) : grace
    };
  }
  function productOf(org) {
    const t = org && org.type;
    return t === "agents" ? "agency" : t || "property";
  }
  function planById(cat, id) {
    var _a;
    return (_a = cat.plans.find((p) => p.id === id)) != null ? _a : null;
  }
  function moduleByKey(cat, key) {
    var _a;
    return (_a = cat.modules.find((m) => m.key === key)) != null ? _a : null;
  }
  var moduleName = (cat, key) => (moduleByKey(cat, key) || { name: MODULE_NAME[key] || "This module" }).name;
  function corePlan(org) {
    return {
      id: "CORE",
      name: "Core product \u2014 no plan assigned yet",
      tier: null,
      products: [productOf(org)],
      modules: [],
      buildingsIncluded: 1,
      extraBuilding: null,
      base: null,
      frequency: "monthly",
      trialDays: DEFAULT_TRIAL_POLICY.trialDays,
      taxPct: 0,
      taxNote: "Set when PALTAS assigns a plan",
      capacity: { sites: null, units: null }
    };
  }
  function priceIn(price, ccy) {
    if (!price)
      return null;
    if (ccy && price.byCcy && price.byCcy[ccy] != null) {
      return { amount: +price.byCcy[ccy], ccy, per: price.per || "month" };
    }
    if (price.amount == null)
      return null;
    if (!ccy || price.ccy === ccy)
      return { amount: +price.amount, ccy: price.ccy, per: price.per || "month" };
    return null;
  }
  function effectivePlanId(org, today) {
    const e = org.ent;
    let id = e.plan;
    (e.pending || []).forEach((p) => {
      if (p.type === "plan" && p.effective <= today)
        id = p.plan;
    });
    return id;
  }
  function cancelledAddons(org, today) {
    return (org.ent.pending || []).filter((p) => p.type === "cancelAddon" && p.effective <= today).map((p) => p.key);
  }
  function nextBilling(org, today) {
    const e = org.ent;
    if (e.status === "trial" && e.trialEnds)
      return e.trialEnds;
    const a = e.anchor;
    if (!a)
      return null;
    let n = a;
    let guard = 0;
    while (n <= today && guard++ < 600)
      n = addMonths(a, guard);
    return n;
  }
  function productsOf(org) {
    const a = org && org.type ? [org.type] : [];
    const subs = org && org.subs || {};
    Object.keys(subs).forEach((k) => {
      if (subs[k] && a.indexOf(k) < 0)
        a.push(k);
    });
    return a;
  }
  function subOf(org, product) {
    if (!org)
      return null;
    if (!product || product === org.type)
      return org.ent || null;
    return (org.subs || {})[product] || null;
  }
  function viewOf(cat, org, product, today) {
    const p = product || org.type;
    const s = subOf(org, p);
    if (!s)
      return null;
    const all = productsOf(org);
    const me = all.indexOf(p);
    const shared = {};
    all.forEach((q, qi) => {
      if (q === p)
        return;
      const other = {
        id: org.id,
        name: org.name,
        type: q,
        currency: org.currency,
        demo: !!org.demo,
        ent: subOf(org, q)
      };
      const r = resolve(cat, other, today);
      if (!r || !r.usable)
        return;
      cat.modules.forEach((m) => {
        const st = r.moduleState[m.key];
        if (m.scope !== "organisation" || !st || !st.on || shared[m.key])
          return;
        if (st.source === "plan" || st.source === "addon" && qi < me)
          shared[m.key] = PRODUCT_NAME[q] || q;
      });
    });
    return {
      id: org.id,
      name: org.name,
      type: p,
      currency: org.currency,
      demo: !!org.demo,
      ent: s,
      shared,
      products: all
    };
  }
  function resolve(cat, org, today) {
    if (!org)
      return null;
    const e = org.ent || {};
    e.addons = e.addons || [];
    e.disabled = e.disabled || [];
    e.buildings = e.buildings || { extra: 0, override: null };
    const addons = e.addons;
    const disabled = e.disabled;
    const buildings = e.buildings;
    const pl = planById(cat, effectivePlanId(org, today)) || corePlan(org);
    const prod = productOf(org);
    const trialOver = e.status === "trial" && !!e.trialEnds && addDays(e.trialEnds, e.graceDays || 0) < today;
    const ended = (e.pending || []).some((p) => p.type === "cancel" && p.effective <= today);
    const status = ended ? "cancelled" : trialOver ? "expired" : e.status || "trial";
    const gone = cancelledAddons(org, today);
    const pend = e.pending || [];
    const shared = org.shared || {};
    const on = {};
    const state = {};
    cat.modules.forEach((m) => {
      var _a, _b;
      const products = m.products || [];
      const inPlan = pl.modules.indexOf(m.key) >= 0;
      const addon = addons.indexOf(m.key) >= 0 && gone.indexOf(m.key) < 0;
      const offered = products.indexOf(prod) >= 0 || (pl.products || []).some((p) => products.indexOf(p) >= 0);
      const viaOrg = !inPlan && m.scope === "organisation" && !!shared[m.key] && offered;
      const isOn = (inPlan || addon || viaOrg) && disabled.indexOf(m.key) < 0 && m.available !== false;
      const cancelsOn = ((_a = pend.filter((p) => p.type === "cancelAddon" && p.key === m.key && p.effective > today)[0]) == null ? void 0 : _a.effective) || null;
      on[m.key] = isOn;
      state[m.key] = {
        on: isOn,
        source: inPlan ? "plan" : viaOrg ? "organisation" : addon ? "addon" : null,
        sharedFrom: viaOrg ? (_b = shared[m.key]) != null ? _b : null : null,
        scope: m.scope || "product",
        offered,
        available: m.available !== false,
        cancelsOn,
        why: ""
      };
    });
    cat.modules.forEach((m) => {
      const st = state[m.key];
      if (on[m.key] && (m.dep || []).some((d) => !on[d])) {
        on[m.key] = false;
        st.on = false;
        st.why = "Needs " + (m.dep || []).map((d) => moduleName(cat, d)).join(", ");
      }
    });
    cat.modules.forEach((m) => {
      const s = state[m.key];
      if (s.on || s.why)
        return;
      s.why = !s.offered ? "Not offered for this product" : !s.available ? "Not available yet" : disabled.indexOf(m.key) >= 0 ? "Switched off by PALTAS" : "Not in your plan";
    });
    const included = buildings.override != null ? buildings.override : pl.buildingsIncluded;
    const allowed = included + (buildings.extra || 0);
    const used = (e.usage || { buildings: 0 }).buildings || 0;
    const family = cat.plans.filter((x) => (x.products || [])[0] === (pl.products || [])[0] && x.tier).sort((a, b) => rank(a.tier) - rank(b.tier));
    const myRank = rank(pl.tier);
    return {
      org: org.id,
      name: org.name,
      demo: !!org.demo,
      product: prod,
      productKey: org.type,
      productName: PRODUCT_NAME[org.type] || org.type,
      orgProducts: org.products || [org.type],
      status,
      usable: status === "active" || status === "trial",
      readOnly: !(status === "active" || status === "trial"),
      plan: pl,
      planId: pl.id,
      tier: pl.tier || null,
      trialEnds: e.trialEnds || null,
      products: pl.products,
      modules: on,
      moduleState: state,
      essentials: ESSENTIALS.map((x) => x[1]),
      floor: FLOOR[prod] || [],
      buildings: {
        included,
        extra: buildings.extra || 0,
        allowed,
        used,
        left: Math.max(0, allowed - used),
        over: used > allowed
      },
      extraBuilding: pl.extraBuilding,
      frequency: pl.frequency,
      taxPct: pl.taxPct,
      taxNote: pl.taxNote,
      terms: e.terms || { discountPct: 0, note: "" },
      billing: e.billing || { status: "" },
      nextBilling: nextBilling(org, today),
      pending: pend.filter((p) => p.effective > today),
      upgrades: family.filter((x) => rank(x.tier) > myRank).map((x) => ({ id: x.id, tier: x.tier, name: x.name, contactSales: x.tier === "Enterprise" || !x.base })),
      downgrades: family.filter((x) => rank(x.tier) < myRank && myRank < 3).map((x) => ({ id: x.id, tier: x.tier, name: x.name }))
    };
  }
  function charges(cat, org, today, ccy) {
    const en = resolve(cat, org, today);
    const pl = en.plan;
    const c = ccy || org.currency;
    const lines = [];
    const missing = [];
    const base = priceIn(pl.base, c);
    if (pl.base && pl.base.amount != null && !base)
      missing.push(pl.name);
    if (base)
      lines.push({ kind: "plan", what: pl.name, amount: base.amount });
    (org.ent.addons || []).forEach((k) => {
      const s = en.moduleState[k];
      if (!s || s.source !== "addon" || !s.on)
        return;
      const m = moduleByKey(cat, k);
      const p = priceIn(m && m.price, c);
      if (!p || !m) {
        missing.push(m ? m.name : k);
        return;
      }
      lines.push({ kind: "addon", key: k, what: m.name, amount: p.amount });
    });
    const xb = priceIn(pl.extraBuilding, c);
    if (en.buildings.extra > 0) {
      if (xb)
        lines.push({
          kind: "buildings",
          what: "Additional buildings \xD7 " + en.buildings.extra,
          amount: xb.amount * en.buildings.extra
        });
      else
        missing.push("Additional buildings");
    }
    const gross = lines.reduce((a, l) => a + l.amount, 0);
    const disc = r2(gross * ((en.terms.discountPct || 0) / 100));
    const net = r2(gross - disc);
    const tax = r2(net * ((pl.taxPct || 0) / 100));
    return {
      ccy: c,
      lines,
      gross: r2(gross),
      discount: disc,
      net,
      taxPct: pl.taxPct || 0,
      taxNote: pl.taxNote || "",
      tax,
      total: r2(net + tax),
      missing,
      priced: !missing.length && lines.length > 0
    };
  }
  function canBuy(cat, org, key, today) {
    const en = resolve(cat, org, today);
    const m = moduleByKey(cat, key);
    if (!m)
      return { ok: false, why: "Unknown module" };
    const s = en.moduleState[key];
    if (!en.usable)
      return { ok: false, why: "Your subscription is " + en.status + " \u2014 renew or choose a plan first" };
    if (s.source === "plan")
      return { ok: false, included: true, why: m.name + " is already included in your plan \u2014 there is nothing to buy" };
    if (s.source === "organisation")
      return {
        ok: false,
        included: true,
        why: m.name + " already covers your whole organisation through your " + s.sharedFrom + " subscription \u2014 there is nothing to buy"
      };
    if (s.source === "addon" && !s.cancelsOn)
      return { ok: false, owned: true, why: m.name + " is already active on your subscription" };
    if (!s.offered)
      return {
        ok: false,
        why: m.name + " is not offered for " + en.product + " workspaces"
      };
    if (m.available === false)
      return { ok: false, why: m.name + " is not available yet" };
    const clash = (m.excludes || []).filter((x) => en.modules[x]);
    if (clash.length)
      return { ok: false, why: m.name + " cannot be combined with " + clash.map((x) => moduleName(cat, x)).join(", ") };
    const need = (m.dep || []).filter((d) => !en.modules[d]);
    if (need.length)
      return {
        ok: false,
        needs: need,
        why: m.name + " needs " + need.map((d) => moduleName(cat, d)).join(", ") + " first"
      };
    if (en.tier === "Enterprise")
      return {
        ok: false,
        contactSales: true,
        why: "Enterprise packages are agreed with PALTAS \u2014 ask your account manager"
      };
    const p = priceIn(m.price, org.currency);
    if (!p)
      return {
        ok: false,
        contactSales: true,
        why: "PALTAS has not set a price for " + m.name + " in " + org.currency + " yet \u2014 ask PALTAS for a quote"
      };
    const disc = r2(p.amount * ((en.terms.discountPct || 0) / 100));
    const net = r2(p.amount - disc);
    const tax = r2(net * ((en.plan.taxPct || 0) / 100));
    return {
      ok: true,
      module: m,
      price: p,
      discount: disc,
      net,
      tax,
      total: r2(net + tax),
      taxNote: en.plan.taxNote,
      from: today,
      nextBilling: en.nextBilling
    };
  }
  function canChangePlan(cat, org, planId, today) {
    const en = resolve(cat, org, today);
    const to = planById(cat, planId);
    if (!to)
      return { ok: false, why: "Unknown plan" };
    const renew = to.id === en.planId && (en.status === "expired" || en.status === "cancelled");
    if (to.id === en.planId && !renew)
      return { ok: false, why: "You are already on " + to.name };
    if ((to.products || [])[0] !== (en.plan.products || [])[0] && en.planId !== "CORE")
      return { ok: false, why: to.name + " is for a different product" };
    if (to.tier === "Enterprise" && !/^PALTAS-20261027-(property|agency|developer|hotel|security)-Enterprise$/.test(to.id) || !to.base)
      return {
        ok: false,
        contactSales: true,
        why: "Enterprise is agreed with PALTAS \u2014 send a request and an account manager will contact you"
      };
    const up = renew || rank(to.tier) > rank(en.tier) || en.planId === "CORE" || !en.usable;
    const allow = (to.buildingsIncluded || 0) + (en.buildings.extra || 0);
    if (!up && en.buildings.used > allow)
      return {
        ok: false,
        why: "You use " + en.buildings.used + " buildings; " + to.name + " allows " + allow + ". Keep your extra buildings or stay on your plan."
      };
    const addons = org.ent.addons || [];
    const lost = en.plan.modules.filter((k) => to.modules.indexOf(k) < 0 && addons.indexOf(k) < 0).map((k) => moduleName(cat, k));
    const p = priceIn(to.base, org.currency);
    if (!p)
      return {
        ok: false,
        contactSales: true,
        why: "PALTAS has not set a price for " + to.name + " in " + org.currency + " yet"
      };
    const effective = up ? today : en.nextBilling || today;
    const dup = addons.filter((k) => to.modules.indexOf(k) >= 0).map((k) => moduleName(cat, k));
    return {
      ok: true,
      upgrade: up,
      renew,
      plan: to,
      price: p,
      effective,
      readOnlyAfter: lost,
      addonsBecomeIncluded: dup
    };
  }
  function validatePlan(cat, pl) {
    const errs = [];
    if (!pl || String(pl.name || "").trim().length < 3)
      errs.push("Name the plan");
    const prods = pl.products || [];
    if (!prods.length)
      errs.push("Pick the product this plan is for");
    const mods = pl.modules || [];
    mods.forEach((k) => {
      const m = moduleByKey(cat, k);
      if (!m) {
        errs.push("Unknown module " + k);
        return;
      }
      if (!prods.some((p) => (m.products || []).indexOf(p) >= 0))
        errs.push(m.name + " is not offered for " + prods.join(", "));
      (m.dep || []).forEach((d) => {
        if (mods.indexOf(d) < 0)
          errs.push(m.name + " needs " + moduleName(cat, d) + " in the same plan");
      });
      (m.excludes || []).forEach((x) => {
        if (mods.indexOf(x) >= 0)
          errs.push(m.name + " cannot be sold with " + moduleName(cat, x));
      });
    });
    if (!(pl.buildingsIncluded >= 0))
      errs.push("Included buildings must be 0 or more");
    if (pl.base && pl.base.amount != null && !(+pl.base.amount > 0))
      errs.push("Base price must be above zero, or leave it for PALTAS to agree (Enterprise)");
    if (pl.taxPct != null && !(pl.taxPct >= 0 && pl.taxPct <= 100))
      errs.push("Tax 0\u2013100%");
    if (["monthly", "quarterly", "yearly"].indexOf(pl.frequency || "monthly") < 0)
      errs.push("Billing period must be monthly, quarterly or yearly");
    if (pl.trialDays != null && !(pl.trialDays >= 0 && pl.trialDays <= 90))
      errs.push("Trial 0\u201390 days");
    return errs;
  }
  function validateModule(_cat, key, m) {
    const errs = [];
    if ((m.dep || []).indexOf(key) >= 0)
      errs.push("A module cannot depend on itself");
    if ((m.excludes || []).indexOf(key) >= 0)
      errs.push("A module cannot exclude itself");
    (m.dep || []).forEach((d) => {
      if ((m.excludes || []).indexOf(d) >= 0)
        errs.push("A module cannot both need and exclude " + d);
    });
    if (m.price && m.price.amount != null && !(+m.price.amount > 0))
      errs.push("Price must be above zero, or unset");
    if (m.scope != null && ["product", "organisation"].indexOf(m.scope) < 0)
      errs.push("Scope must be per product or organisation-wide");
    return errs;
  }
  return __toCommonJS(rules_exports);
})();
  var api = Object.assign({}, __paltasBundle);
  if (typeof module === "object" && module && module.exports) module.exports = api;
  if (root) root.PaltasEntitlements = api;
})(typeof self !== "undefined" ? self : this);
