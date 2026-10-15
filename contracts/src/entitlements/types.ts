// Shapes the entitlement rules work on. The same shapes are used by the browser demo and by the server.

/** A product an organisation can subscribe to. "agents" is the browser's older name for "agency". */
export type ProductKey = "property" | "developer" | "agency" | "hotel" | "security";
export type OrgType = ProductKey | "agents";

export type Tier = "Standard" | "Pro" | "Enterprise";
export type SubscriptionStatus = "trial" | "active" | "suspended" | "expired";
/** Status after the rules have looked at dates: a trial past its end is "expired", an ended cancellation is "cancelled". */
export type ResolvedStatus = SubscriptionStatus | "cancelled";
export type ModuleScope = "product" | "organisation";

/** A price in one currency. `byCcy` holds prices PALTAS has set for other currencies; nothing is ever converted. */
export interface Price {
  amount?: number | null;
  ccy?: string;
  per?: string;
  byCcy?: Record<string, number>;
}
export interface PriceIn {
  amount: number;
  ccy: string;
  per: string;
}

export interface CatalogueModule {
  key: string;
  name: string;
  products?: string[];
  dep?: string[];
  excludes?: string[];
  scope?: ModuleScope;
  price?: Price | null;
  available?: boolean;
}

export interface Plan {
  id: string;
  name: string;
  tier: Tier | null;
  products: string[];
  modules: string[];
  buildingsIncluded: number;
  extraBuilding?: Price | null;
  base?: Price | null;
  frequency?: string;
  trialDays?: number;
  taxPct?: number | null;
  taxNote?: string;
  capacity?: { sites: number | null; units: number | null };
}

export interface Catalogue {
  modules: CatalogueModule[];
  plans: Plan[];
}

export type PendingChange =
  | { id?: string; type: "plan"; plan: string; effective: string; reason?: string | null; key?: string | null }
  | { id?: string; type: "cancelAddon"; key: string; effective: string; reason?: string | null; plan?: string | null }
  | {
      id?: string;
      type: "cancel";
      effective: string;
      reason?: string | null;
      key?: string | null;
      plan?: string | null;
    };

/** One product subscription as stored. */
export interface Subscription {
  plan: string;
  status: SubscriptionStatus;
  trialEnds?: string | null;
  /** Days the workspace keeps working after trialEnds (from the trial policy when the trial started; default 0). */
  graceDays?: number;
  anchor?: string | null;
  addons?: string[];
  disabled?: string[];
  pending?: PendingChange[];
  buildings?: { extra: number; override: number | null };
  terms?: { discountPct: number; note: string };
  usage?: { buildings: number };
  billing?: { status: string };
}

/**
 * An organisation as the rules see it: the first product's subscription is in `ent`,
 * every further product's subscription is in `subs[product]`.
 */
export interface OrgRecord {
  id: string;
  name: string;
  type: OrgType;
  currency: string;
  demo?: boolean;
  ent: Subscription;
  subs?: Partial<Record<string, Subscription>>;
}

/** The record for ONE product subscription (made by viewOf). */
export interface OrgView {
  id: string;
  name: string;
  type: OrgType;
  currency: string;
  demo: boolean;
  ent: Subscription;
  /** Organisation-wide modules held through another product: module key → that product's name. */
  shared?: Record<string, string>;
  products?: string[];
}

export interface ModuleState {
  on: boolean;
  source: "plan" | "organisation" | "addon" | null;
  sharedFrom: string | null;
  scope: ModuleScope;
  offered: boolean;
  available: boolean;
  cancelsOn: string | null;
  why: string;
}

export interface Entitlement {
  org: string;
  name: string;
  demo: boolean;
  product: string;
  productKey: OrgType;
  productName: string;
  orgProducts: string[];
  status: ResolvedStatus;
  usable: boolean;
  readOnly: boolean;
  plan: Plan;
  planId: string;
  tier: Tier | null;
  trialEnds: string | null;
  products: string[];
  modules: Record<string, boolean>;
  moduleState: Record<string, ModuleState>;
  essentials: string[];
  floor: string[];
  buildings: { included: number; extra: number; allowed: number; used: number; left: number; over: boolean };
  extraBuilding: Price | null | undefined;
  frequency: string | undefined;
  taxPct: number | null | undefined;
  taxNote: string | undefined;
  terms: { discountPct: number; note: string };
  billing: { status: string };
  nextBilling: string | null;
  pending: PendingChange[];
  upgrades: { id: string; tier: Tier | null; name: string; contactSales: boolean }[];
  downgrades: { id: string; tier: Tier | null; name: string }[];
}

export interface ChargeLine {
  kind: string;
  what: string;
  amount: number;
  key?: string;
}

export interface Charges {
  ccy: string;
  lines: ChargeLine[];
  gross: number;
  discount: number;
  net: number;
  taxPct: number;
  taxNote: string;
  tax: number;
  total: number;
  missing: string[];
  priced: boolean;
}

export type BuyCheck =
  | {
      ok: true;
      module: CatalogueModule;
      price: PriceIn;
      discount: number;
      net: number;
      tax: number;
      total: number;
      taxNote: string | undefined;
      from: string;
      nextBilling: string | null;
    }
  | { ok: false; why: string; included?: boolean; owned?: boolean; needs?: string[]; contactSales?: boolean };

export type PlanChangeCheck =
  | {
      ok: true;
      upgrade: boolean;
      renew: boolean;
      plan: Plan;
      price: PriceIn;
      effective: string;
      readOnlyAfter: string[];
      addonsBecomeIncluded: string[];
    }
  | { ok: false; why: string; contactSales?: boolean };

/** The ONE platform trial policy (a database row the Super Admin changes; DEFAULT_TRIAL_POLICY is its first version). */
export interface TrialPolicy {
  trialDays: number;
  graceDays: number;
  /** Reminders this many days before the trial ends. */
  reminderDays: number[];
  /** A self-service account still unverified this many days after sign-up is suspended. */
  verifyWithinDays: number;
  verifyLinkHours: number;
  /** An earlier trial of the same business inside this window blocks a new one. */
  repeatWindowDays: number;
  repeatMatch: ("email" | "phone" | "company")[];
  /** A further product on an organisation: its own trial (once per product) or paid from day one. */
  secondProduct: "own_trial" | "no_trial";
  atExpiry: "read_only";
  keepRecords: true;
  exportAllowed: boolean;
}

/** Where a subscription stands in its trial, on a given day (made by trialState). */
export interface TrialState {
  /** trial: within the trial days · grace: past the last trial day, still working · expired: read-only. */
  phase: "trial" | "grace" | "expired";
  trialEnds: string;
  graceEnds: string;
  /** Days until the last trial day (0 on the last day itself, never below 0). */
  daysLeft: number;
  /** Days of grace left (the full grace while in trial, 0 once expired). */
  graceDaysLeft: number;
}
