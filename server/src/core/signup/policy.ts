/*
 * The ONE platform trial policy (table trial_policy, one row) and everything that starts a trial with it.
 *
 * Every path that starts a trial goes through openSubscription() here — self-service sign-up, staff onboarding
 * (create organisation, add product), a further product added by the customer and the agency "For Business"
 * approval (which runs the staff onboarding) — so no product, plan or path can give a different trial:
 *
 *   - length: policy.trialDays for every plan and product (catalogue_plans.trial_days is not read);
 *   - grace: policy.graceDays, kept on the subscription when the trial starts (a later policy change applies to new
 *     trials only);
 *   - one trial per business: an earlier trial with the same e-mail, phone, or company name + country inside
 *     policy.repeatWindowDays blocks a new one (staff can override with a reason, kept in trial_registry);
 *   - a further product on an organisation (policy.secondProduct): "own_trial" — its own trial of policy.trialDays,
 *     once per product, not counted as a repeat because it is the same business adding a product; "no_trial" — paid
 *     from day one. The same rule for all five products.
 */
import type { Product, signup } from "@paltas/contracts";
import type { z } from "@paltas/contracts";
import type { Db } from "../../db/database.js";
import { fail } from "../../http/errors.js";
import { addDays } from "../../lib/dates.js";

export type TrialPolicy = z.infer<typeof signup.TrialPolicy>;
export type RepeatBy = "email" | "phone" | "company";

interface PolicyRow {
  version: number;
  trial_days: number;
  grace_days: number;
  reminder_days: number[];
  verify_within_days: number;
  verify_link_hours: number;
  repeat_window_days: number;
  repeat_match: RepeatBy[];
  second_product: "own_trial" | "no_trial";
  at_expiry: "read_only";
  keep_records: true;
  export_allowed: boolean;
  updated_at: string;
}

const toPolicy = (r: PolicyRow): TrialPolicy => ({
  version: r.version,
  trialDays: r.trial_days,
  graceDays: r.grace_days,
  reminderDays: r.reminder_days,
  verifyWithinDays: r.verify_within_days,
  verifyLinkHours: r.verify_link_hours,
  repeatWindowDays: r.repeat_window_days,
  repeatMatch: r.repeat_match,
  secondProduct: r.second_product,
  atExpiry: r.at_expiry,
  keepRecords: r.keep_records,
  exportAllowed: r.export_allowed,
  updatedAt: r.updated_at,
});

/** The policy as it is now. With lock, the row is held until the transaction ends (policy changes queue behind). */
export async function loadPolicy(t: Db, lock = false): Promise<TrialPolicy> {
  const r = await t.row<PolicyRow>(`SELECT * FROM trial_policy WHERE id = 1${lock ? " FOR UPDATE" : ""}`);
  if (!r) throw new Error("The platform trial policy is missing (migration 0013)");
  return toPolicy(r);
}

/** The policy as the history keeps it (without version and time, which are columns of their own). */
export function policyRecord(p: TrialPolicy) {
  return {
    trialDays: p.trialDays,
    graceDays: p.graceDays,
    reminderDays: p.reminderDays,
    verifyWithinDays: p.verifyWithinDays,
    verifyLinkHours: p.verifyLinkHours,
    repeatWindowDays: p.repeatWindowDays,
    repeatMatch: p.repeatMatch,
    secondProduct: p.secondProduct,
    atExpiry: p.atExpiry,
    keepRecords: p.keepRecords,
    exportAllowed: p.exportAllowed,
  };
}

export type PolicyInput = Omit<TrialPolicy, "version" | "updatedAt" | "atExpiry" | "keepRecords">;

/** Save a new version and keep it in the history. The caller checks the Super Admin role and audits. */
export async function savePolicy(t: Db, input: PolicyInput, reason: string, userId: string) {
  const before = await loadPolicy(t, true);
  const reminders = [...new Set(input.reminderDays)].sort((a, b) => b - a);
  if (reminders.some((d) => d >= input.trialDays))
    throw fail.invalid("Reminders must fall inside the trial: each one fewer days than the trial length");
  const row = await t.row<PolicyRow>(
    `UPDATE trial_policy SET version = version + 1, trial_days = $1, grace_days = $2, reminder_days = $3,
       verify_within_days = $4, verify_link_hours = $5, repeat_window_days = $6, repeat_match = $7,
       second_product = $8, export_allowed = $9, updated_by = $10, updated_at = now()
     WHERE id = 1 RETURNING *`,
    [
      input.trialDays,
      input.graceDays,
      reminders,
      input.verifyWithinDays,
      input.verifyLinkHours,
      input.repeatWindowDays,
      [...new Set(input.repeatMatch)],
      input.secondProduct,
      input.exportAllowed,
      userId,
    ],
  );
  const after = toPolicy(row as PolicyRow);
  await t.run("INSERT INTO trial_policy_history (version, policy, reason, changed_by) VALUES ($1,$2,$3,$4)", [
    after.version,
    JSON.stringify(policyRecord(after)),
    reason,
    userId,
  ]);
  return { before, after };
}

export async function policyHistory(t: Db) {
  const rows = await t.rows<{
    version: number;
    policy: Record<string, unknown>;
    reason: string;
    changed_by: string | null;
    changed_at: string;
  }>("SELECT * FROM trial_policy_history ORDER BY version DESC");
  return rows.map((r) => ({
    version: r.version,
    policy: r.policy,
    reason: r.reason,
    changedBy: r.changed_by,
    changedAt: r.changed_at,
  }));
}

// ---------------------------------------------------------------- who the business is (one trial per business)

const LEGAL_WORDS = new Set([
  "the",
  "ltd",
  "limited",
  "llc",
  "llp",
  "inc",
  "incorporated",
  "plc",
  "co",
  "company",
  "corp",
  "corporation",
  "group",
  "holdings",
  "gmbh",
  "ag",
  "sa",
  "sarl",
  "srl",
  "bv",
  "nv",
  "ab",
  "uab",
  "pty",
  "pvt",
  "private",
  "and",
]);

/** "The Kilima Homes Ltd." and "kilima-homes limited" are the same business: "kilima homes". */
export function companyKey(name: string): string {
  const words = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter(Boolean);
  const kept = words.filter((w) => !LEGAL_WORDS.has(w));
  return (kept.length ? kept : words).join(" ");
}

/** A phone number in international form: "+254 700 000-000" → "+254700000000". */
export function phoneKey(raw: string): string {
  const v = raw.replace(/[\s().-]/g, "");
  if (!/^\+[1-9]\d{7,14}$/.test(v))
    throw fail.invalid("Give the phone number in international form, e.g. +254700000000");
  return v;
}

export interface BusinessIdentity {
  company: string;
  country: string;
  email?: string | null;
  phone?: string | null;
}

export interface RepeatMatch {
  by: RepeatBy;
  orgId: string;
}

/** Earlier trials of the same business inside the policy window (empty = this business may start a trial). */
export async function findRepeats(
  t: Db,
  policy: TrialPolicy,
  today: string,
  who: BusinessIdentity,
): Promise<RepeatMatch[]> {
  if (!policy.repeatWindowDays) return [];
  const since = addDays(today, -policy.repeatWindowDays);
  const rows = await t.rows<{ match_by: RepeatBy; org_id: string }>(
    `SELECT DISTINCT match_by, org_id FROM (
       SELECT 'company' AS match_by, org_id FROM trial_registry
        WHERE 'company' = ANY($2) AND company_key = $3 AND country = $4 AND started_on >= $1
       UNION ALL
       SELECT 'email', org_id FROM trial_registry WHERE 'email' = ANY($2) AND email = $5 AND started_on >= $1
       UNION ALL
       SELECT 'phone', org_id FROM trial_registry WHERE 'phone' = ANY($2) AND phone = $6 AND started_on >= $1
     ) m ORDER BY match_by, org_id`,
    [
      since,
      policy.repeatMatch,
      companyKey(who.company),
      who.country.trim().toLowerCase(),
      who.email?.toLowerCase() ?? null,
      who.phone ?? null,
    ],
  );
  return rows.map((r) => ({ by: r.match_by, orgId: r.org_id }));
}

// ---------------------------------------------------------------- opening a subscription (trial or not)

export interface TrialStart {
  /** Who the business is, for the one-trial-per-business check and the registry. */
  who: BusinessIdentity;
  source: "signup" | "staff" | "second_product";
  /** Staff override of a repeat, kept with the trial. */
  override?: { reason: string; by: string } | null;
}

/**
 * Create one product subscription. With `trial`, the trial follows the platform policy (length, grace, one per
 * business) and is entered in the trial registry; without it the subscription is active (staff) or waits for
 * payment (`awaitingPayment`: expired until its first invoice is paid).
 */
export async function openSubscription(
  t: Db,
  s: {
    orgId: string;
    product: Product;
    planId: string;
    today: string;
    trial: TrialStart | null;
    awaitingPayment?: boolean;
  },
): Promise<{ status: "trial" | "active" | "expired"; trialEnds: string | null; graceDays: number }> {
  if (!s.trial) {
    const status = s.awaitingPayment ? "expired" : "active";
    await t.run(
      "INSERT INTO subscriptions (org_id, product, plan_id, status, trial_ends, anchor) VALUES ($1,$2,$3,$4,NULL,$5)",
      [s.orgId, s.product, s.planId, status, status === "active" ? s.today : null],
    );
    return { status, trialEnds: null, graceDays: 0 };
  }
  // one policy decision at a time: a policy change waits until this trial has started (and vice versa)
  const policy = await loadPolicy(t, true);
  if (s.trial.source !== "second_product") {
    const repeats = await findRepeats(t, policy, s.today, s.trial.who);
    if (repeats.length && !s.trial.override)
      throw fail.conflict(
        `This business already had a PALTAS trial in the last ${policy.repeatWindowDays} days (same ${[...new Set(repeats.map((r) => r.by))].join(", ")}). PALTAS staff can start one with a reason.`,
        { repeatTrial: true, matched: repeats },
      );
  }
  const trialEnds = addDays(s.today, policy.trialDays);
  await t.run(
    `INSERT INTO subscriptions (org_id, product, plan_id, status, trial_ends, anchor, grace_days, trial_started,
       trial_policy_version) VALUES ($1,$2,$3,'trial',$4,NULL,$5,$6,$7)`,
    [s.orgId, s.product, s.planId, trialEnds, policy.graceDays, s.today, policy.version],
  );
  const w = s.trial.who;
  await t.run(
    `INSERT INTO trial_registry (org_id, product, company_key, country, email, phone, started_on, source,
       override_reason, override_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [
      s.orgId,
      s.product,
      companyKey(w.company),
      w.country.trim().toLowerCase(),
      w.email?.toLowerCase() ?? null,
      w.phone ?? null,
      s.today,
      s.trial.source,
      s.trial.override?.reason ?? null,
      s.trial.override?.by ?? null,
    ],
  );
  return { status: "trial", trialEnds, graceDays: policy.graceDays };
}

/** The business behind an existing organisation (for a further product's registry entry). */
export async function organisationIdentity(t: Db, orgId: string): Promise<BusinessIdentity> {
  const o = await t.row<{ name: string; country: string; email: string | null; phone: string | null }>(
    `SELECT o.name, o.country, s.email, s.phone FROM organisations o
     LEFT JOIN org_signups s ON s.org_id = o.id WHERE o.id = $1`,
    [orgId],
  );
  if (!o) throw fail.notFound("Organisation not found");
  return { company: o.name, country: o.country, email: o.email, phone: o.phone };
}

/** Does the policy give a further product of an organisation its own trial? (The same answer for every product.) */
export async function furtherProductTrial(t: Db): Promise<boolean> {
  return (await loadPolicy(t)).secondProduct === "own_trial";
}
