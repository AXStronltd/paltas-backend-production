import { createHash } from "node:crypto";
import type { property as P } from "@paltas/contracts";
import type { OrgScope } from "../../../core/access/org-access.js";
import { memberProductRole } from "../../../core/access/product-role.js";
import { memberCan, managerGrant } from "../../../core/access/manager-access.js";
import { recordAudit } from "../../../core/audit/audit.service.js";
import { variablesOf, render } from "../../../core/notifications/notifications.service.js";
import type { Db } from "../../../db/database.js";
import { fail } from "../../../http/errors.js";
import { formatMoney } from "../../../lib/money.js";
import { newId } from "../../../lib/ids.js";
import type { PmDeps } from "../deps.js";
import { financeTransaction } from "../shared/finance-transaction.js";
import { balanceOf, invoiceRow, propertyRow } from "../shared/records.js";
import { daysBetween } from "../shared/util.js";
export const COLLECTION_REMINDERS_JOB = "property.collection_reminders";
export const DEFAULT_REMINDERS: P.ReminderPolicyInput = {
  enabled: false,
  daysAfterDue: [0, 3, 7, 14],
  subject: "{{company}} — payment reminder {{invoice}}",
  body: "Hello {{tenant}},\n\nInvoice {{invoice}} for unit {{unit}} has an outstanding balance of {{balance}} and a due date of {{dueDate}}. Please contact your property manager for payment instructions, or if you have already paid or need to query this amount.\n\n{{company}}",
  skipDisputes: true,
  skipPlans: true,
};
type Op = Pick<OrgScope, "orgId" | "today" | "actor"> & { userId: string | null };
type PolicyRow = { config: P.ReminderPolicyInput; version: number; updated_by: string };
export function collectionRemindersService(d: PmDeps) {
  const { core } = d,
    db = core.db;
  async function property(t: Db, s: Pick<OrgScope, "orgId" | "propertyIds">, id: string) {
    if (s.propertyIds && !s.propertyIds.includes(id)) throw fail.notFound("Property not found");
    return propertyRow(t, s.orgId, id);
  }
  async function policy(t: Db, orgId: string, propertyId: string): Promise<P.ReminderPolicy> {
    const r = await t.row<PolicyRow>(
      "SELECT config,version,updated_by FROM pm_collection_reminder_policies WHERE org_id=$1 AND property_id=$2",
      [orgId, propertyId],
    );
    return {
      propertyId,
      version: r?.version ?? 0,
      input: r?.config ?? DEFAULT_REMINDERS,
      emailConfigured: core.notifications.emailDeliveryConfigured(),
    };
  }
  async function candidate(
    t: Db,
    s: Op,
    propertyId: string,
    id: string,
    p: P.ReminderPolicy,
  ): Promise<P.ReminderCandidate> {
    const inv = await invoiceRow(t, s.orgId, id);
    if (inv.property_id !== propertyId) throw fail.notFound("Invoice not found in this property");
    const c = await t.row<{ email: string | null; consent_email: boolean }>(
      "SELECT email,consent_email FROM contacts WHERE org_id=$1 AND id=$2",
      [s.orgId, inv.tenant_id],
    );
    const org = await t.row<{ name: string; currency: string }>("SELECT name,currency FROM organisations WHERE id=$1", [
      s.orgId,
    ]);
    if (!org) throw fail.notFound("Organisation not found");
    const recipient = (c?.email ?? "").trim().toLowerCase(),
      balance = balanceOf(inv),
      elapsed = daysBetween(inv.due_date, s.today);
    const reached = p.input.daysAfterDue.filter((x) => x <= elapsed),
      stageDays = reached.length ? Math.max(...reached) : null;
    const disputed = !!(await t.row(
      "SELECT id FROM pm_billing_disputes WHERE org_id=$1 AND invoice_id=$2 AND status IN ('open','reviewing')",
      [s.orgId, id],
    ));
    const arranged = !!(await t.row(
      "SELECT id FROM pm_collection_plans WHERE org_id=$1 AND invoice_id=$2 AND status IN ('active','paused')",
      [s.orgId, id],
    ));
    const already =
      stageDays === null
        ? null
        : await t.row(
            "SELECT id FROM pm_collection_reminders WHERE org_id=$1 AND invoice_id=$2 AND ((due_date=$3 AND stage_days=$4) OR sent_date=$5)",
            [s.orgId, id, inv.due_date, stageDays, s.today],
          );
    const vars = {
      company: org.name,
      invoice: inv.number,
      tenant: inv.tenant_name,
      unit: inv.unit_no ?? "—",
      balance: formatMoney(Math.max(0, balance), org.currency),
      currency: org.currency,
      dueDate: inv.due_date,
    };
    const subject = render(p.input.subject, vars),
      body = render(p.input.body, vars);
    const reason =
      inv.issue_date > s.today
        ? "This invoice has not been issued yet"
        : balance <= 0
          ? "This invoice is settled"
          : stageDays === null
            ? "No reminder date has been reached"
            : already
              ? "A reminder was already recorded for this stage or today"
              : p.input.skipDisputes && disputed
                ? "An open billing query is under review"
                : p.input.skipPlans && arranged
                  ? "An approved payment arrangement is being tracked"
                  : !c?.consent_email
                    ? "Email contact permission is not recorded"
                    : !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(recipient)
                      ? "Add a valid tenant email address"
                      : !p.emailConfigured
                        ? "Transactional email delivery is not configured"
                        : "";
    const previewKey = createHash("sha256")
      .update(
        JSON.stringify([s.orgId, propertyId, id, s.today, p.version, recipient, subject, body, reason, stageDays]),
      )
      .digest("hex");
    return {
      invoiceId: id,
      invoiceNumber: inv.number,
      tenantName: inv.tenant_name,
      recipient,
      balanceMinor: Math.max(0, balance),
      dueDate: inv.due_date,
      stageDays,
      subject,
      body,
      canSend: !reason,
      reason,
      previewKey,
    };
  }
  const unpaid = `i.org_id=$1 AND i.property_id=$2 AND i.issue_date<=$3::date AND i.amount_minor>COALESCE((SELECT sum(a.amount_minor) FROM pm_effective_allocations a WHERE a.org_id=$1 AND a.invoice_id=i.id),0)`;
  async function record(t: Db, s: Op, propertyId: string, p: P.ReminderPolicy, c: P.ReminderCandidate) {
    if (!c.canSend || c.stageDays === null) throw fail.conflict(c.reason || "Refresh the reminder preview");
    const inv = await invoiceRow(t, s.orgId, c.invoiceId);
    const n = await core.notifications.record(t, {
      orgId: s.orgId,
      channel: "email",
      to: c.recipient,
      category: "transactional",
      subject: c.subject,
      body: c.body,
      source: "property_invoice",
      sourceRef: `reminder:${c.invoiceId}:${c.dueDate}:${c.stageDays}`,
      createdBy: s.userId,
    });
    await t.run(
      "INSERT INTO pm_collection_reminders(id,org_id,property_id,invoice_id,tenant_id,due_date,stage_days,sent_date,policy_version,notification_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
      [newId("prm"), s.orgId, propertyId, c.invoiceId, inv.tenant_id, c.dueDate, c.stageDays, s.today, p.version, n.id],
    );
    await recordAudit(t, {
      orgId: s.orgId,
      actor: s.actor,
      action: "Collection reminder recorded",
      target: c.invoiceId,
      detail: `${n.id} · ${n.status} · day ${c.stageDays}; provider delivery not assumed`,
    });
    return n.id;
  }
  return {
    async get(s: OrgScope, id: string) {
      await property(db, s, id);
      return policy(db, s.orgId, id);
    },
    async save(s: OrgScope, id: string, b: { expectedVersion: number; input: P.ReminderPolicyInput; reason: string }) {
      await property(db, s, id);
      const allowed = new Set(["company", "invoice", "tenant", "unit", "balance", "currency", "dueDate"]);
      const unknown = variablesOf(b.input.subject, b.input.body).filter((x) => !allowed.has(x));
      if (unknown.length) throw fail.invalid("Unknown template fields: " + unknown.join(", "));
      const fields = variablesOf(b.input.body);
      if (["invoice", "balance", "dueDate"].some((x) => !fields.includes(x)))
        throw fail.invalid(
          "The reminder body must include {{invoice}}, {{balance}} and {{dueDate}} so the recipient can identify the debt.",
        );
      if (b.input.enabled && !core.notifications.emailDeliveryConfigured())
        throw fail.conflict("Configure transactional email delivery before enabling reminders");
      return financeTransaction(db, s.orgId, async (t) => {
        const p = await policy(t, s.orgId, id);
        if (p.version !== b.expectedVersion)
          throw fail.conflict("The reminder policy changed. Reopen it before saving.");
        await t.run(
          "INSERT INTO pm_collection_reminder_policies(org_id,property_id,config,version,updated_by) VALUES($1,$2,$3,1,$4) ON CONFLICT(org_id,property_id) DO UPDATE SET config=EXCLUDED.config,version=pm_collection_reminder_policies.version+1,updated_by=EXCLUDED.updated_by,updated_at=now()",
          [
            s.orgId,
            id,
            JSON.stringify({ ...b.input, daysAfterDue: [...b.input.daysAfterDue].sort((a, b) => a - b) }),
            s.userId,
          ],
        );
        if (b.input.enabled) {
          const org = await t.row<{ timezone: string }>("SELECT timezone FROM organisations WHERE id=$1", [s.orgId]);
          await core.scheduler.ensureJob(t, {
            key: COLLECTION_REMINDERS_JOB,
            orgId: s.orgId,
            targetId: id,
            label: "Reviewed collection reminders",
            cron: "*/15 8-18 * * *",
            timezone: org?.timezone ?? "UTC",
          });
        }
        await recordAudit(t, {
          orgId: s.orgId,
          actor: s.actor,
          action: "Collection reminder policy changed",
          target: id,
          before: p.input,
          after: b.input,
          detail: b.reason,
        });
        return policy(t, s.orgId, id);
      });
    },
    async preview(s: OrgScope, id: string, q: { limit: number; offset: number }) {
      await property(db, s, id);
      return db.tx(async (t) => {
        await t.run("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
        const p = await policy(t, s.orgId, id);
        const args = [s.orgId, id, s.today];
        const count = await t.row<{ n: number }>(`SELECT count(*)::int AS n FROM pm_invoices i WHERE ${unpaid}`, args);
        const ids = await t.rows<{ id: string }>(
          `SELECT i.id FROM pm_invoices i WHERE ${unpaid} ORDER BY i.due_date,i.id LIMIT $4 OFFSET $5`,
          [...args, q.limit, q.offset],
        );
        const candidates = [];
        for (const x of ids) candidates.push(await candidate(t, s, id, x.id, p));
        return { policy: p, candidates, limit: q.limit, offset: q.offset, total: count?.n ?? 0 };
      });
    },
    async send(s: OrgScope, id: string, items: { invoiceId: string; previewKey: string }[]) {
      await property(db, s, id);
      if (new Set(items.map((x) => x.invoiceId)).size !== items.length) throw fail.invalid("Select each invoice once");
      return financeTransaction(db, s.orgId, async (t) => {
        const p = await policy(t, s.orgId, id),
          ready = [];
        for (const x of items) {
          const c = await candidate(t, s, id, x.invoiceId, p);
          if (c.previewKey !== x.previewKey || !c.canSend)
            throw fail.conflict(
              `${c.invoiceNumber}: balance, recipient, policy or eligibility changed. Preview again. ${c.reason}`,
            );
          ready.push(c);
        }
        const notificationIds = [];
        for (const c of ready) notificationIds.push(await record(t, s, id, p, c));
        return { recorded: notificationIds.length, notificationIds };
      });
    },
    async history(s: OrgScope, id: string, q: { limit: number; offset: number }) {
      await property(db, s, id);
      const count = await db.row<{ n: number }>(
        "SELECT count(*)::int AS n FROM pm_collection_reminders WHERE org_id=$1 AND property_id=$2",
        [s.orgId, id],
      );
      const reminders = await db.rows<{
        id: string;
        invoiceId: string;
        invoiceNumber: string;
        tenantName: string;
        recipient: string;
        date: string;
        stageDays: number;
        status: string;
        statusNote: string;
        createdAt: string;
      }>(
        'SELECT r.id,r.invoice_id AS "invoiceId",i.number AS "invoiceNumber",c.name AS "tenantName",n.to_address AS recipient,r.sent_date::text AS date,r.stage_days AS "stageDays",n.status,n.status_note AS "statusNote",r.created_at AS "createdAt" FROM pm_collection_reminders r JOIN pm_invoices i ON i.org_id=r.org_id AND i.id=r.invoice_id JOIN contacts c ON c.org_id=r.org_id AND c.id=r.tenant_id JOIN notifications n ON n.org_id=r.org_id AND n.id=r.notification_id WHERE r.org_id=$1 AND r.property_id=$2 ORDER BY r.created_at DESC,r.id DESC LIMIT $3 OFFSET $4',
        [s.orgId, id, q.limit, q.offset],
      );
      return { total: count?.n ?? 0, reminders };
    },
    async automatic(orgId: string, propertyId: string, today: string) {
      return financeTransaction(db, orgId, async (t) => {
        const orgState = await t.row<{ suspended_at: string | null }>(
          "SELECT suspended_at FROM organisations WHERE id=$1",
          [orgId],
        );
        if (!orgState || orgState.suspended_at) return { summary: "Organisation is unavailable — nothing recorded" };
        const p = await policy(t, orgId, propertyId);
        if (!p.input.enabled || !p.emailConfigured)
          return { summary: "Reminder automation is disabled or email is unavailable — nothing recorded" };
        const author = await t.row<PolicyRow>(
          "SELECT updated_by FROM pm_collection_reminder_policies WHERE org_id=$1 AND property_id=$2",
          [orgId, propertyId],
        );
        const role = author ? await memberProductRole(t, orgId, author.updated_by, "property") : null;
        if (!role || !author || !(await memberCan(t, orgId, author.updated_by, role, "property", "property.billing")))
          return { summary: "Reminder authorisation is no longer active — nothing recorded" };
        if (role === "main_manager") {
          const grant = await managerGrant(t, orgId, author.updated_by, "property");
          if (grant?.propertyIds && !grant.propertyIds.includes(propertyId))
            return { summary: "Property authorisation was revoked — nothing recorded" };
        }
        const s: Op = { orgId, today, userId: null, actor: { userId: null, role: "system:scheduler" } };
        const rows = await t.rows<{ id: string }>(
          `SELECT i.id FROM pm_invoices i JOIN contacts c ON c.org_id=i.org_id AND c.id=i.tenant_id CROSS JOIN LATERAL (SELECT max(day) AS stage FROM unnest($4::int[]) day WHERE day<=($3::date-i.due_date)) due WHERE ${unpaid} AND due.stage IS NOT NULL AND c.consent_email AND c.email ~ '^[^@[:space:]]+@[^@[:space:]]+\\.[^@[:space:]]+$' AND NOT EXISTS(SELECT 1 FROM pm_collection_reminders r WHERE r.org_id=$1 AND r.invoice_id=i.id AND ((r.due_date=i.due_date AND r.stage_days=due.stage) OR r.sent_date=$3::date)) AND (NOT $5::boolean OR NOT EXISTS(SELECT 1 FROM pm_billing_disputes b WHERE b.org_id=$1 AND b.invoice_id=i.id AND b.status IN ('open','reviewing'))) AND (NOT $6::boolean OR NOT EXISTS(SELECT 1 FROM pm_collection_plans a WHERE a.org_id=$1 AND a.invoice_id=i.id AND a.status IN ('active','paused'))) ORDER BY i.due_date,i.id LIMIT 100`,
          [orgId, propertyId, today, p.input.daysAfterDue, p.input.skipDisputes, p.input.skipPlans],
        );
        let recorded = 0;
        for (const x of rows) {
          const c = await candidate(t, s, propertyId, x.id, p);
          if (c.canSend) {
            await record(t, s, propertyId, p, c);
            recorded++;
          }
        }
        return {
          summary: `${recorded} reminder(s) recorded in the notification outbox; delivery requires provider confirmation`,
        };
      });
    },
  };
}
