import { redactSecurityNotification, SECURITY_TEMPLATE_KEYS } from "../notifications/security-messages.js";
/*
 * Data export of ONE organisation (subject access requests, offboarding): every row of every table that carries its
 * org_id, plus rows of tables that only point at such a row (one foreign key away), as a single JSON document.
 *
 * - Streamed: rows are read in batches inside one read-only REPEATABLE READ transaction (a consistent snapshot) and
 *   written as they are read, with back-pressure; a client that goes away ends the read.
 * - Never exported: passwords, sessions, authenticator secrets, token hashes, file bytes (bytea columns), and any
 *   other organisation's rows.
 * - Audited (with the reason) before the first byte is sent.
 */
import { once } from "node:events";
import { PassThrough, type Readable } from "node:stream";
import { ops } from "@paltas/contracts";
import type { AppContext } from "../../context.js";
import type { Db } from "../../db/database.js";
import { fail } from "../../http/errors.js";
import { recordAudit, type Actor } from "../audit/audit.service.js";
import type { SessionUser } from "../identity/identity.service.js";
import { staffActor } from "./admin.service.js";

const BATCH = 500;
const SECRET_COLUMN = /password|secret|sealed|token_hash/i;

export interface TablePlan {
  table: string;
  columns: string[];
  /** SQL condition selecting this organisation's rows ($1 = org id). */
  where: string;
}

const q = (ident: string) => '"' + ident.replace(/"/g, '""') + '"';

/** Which tables an export reads, and how each selects the organisation's rows. */
export async function exportPlan(t: Db): Promise<TablePlan[]> {
  const cols = await t.rows<{ table_name: string; column_name: string; data_type: string }>(
    `SELECT c.table_name, c.column_name, c.data_type FROM information_schema.columns c
     JOIN information_schema.tables tb ON tb.table_schema = c.table_schema AND tb.table_name = c.table_name
     WHERE c.table_schema = current_schema() AND tb.table_type = 'BASE TABLE'
     ORDER BY c.table_name, c.ordinal_position`,
  );
  const byTable = new Map<string, string[]>();
  const withOrg = new Set<string>();
  for (const c of cols) {
    if (c.column_name === "org_id") withOrg.add(c.table_name);
    if (c.data_type === "bytea" || SECRET_COLUMN.test(c.column_name)) continue;
    byTable.set(c.table_name, [...(byTable.get(c.table_name) ?? []), c.column_name]);
  }
  const plans: TablePlan[] = [...withOrg].map((table) => ({
    table,
    columns: byTable.get(table) ?? [],
    where: "org_id = $1",
  }));
  // tables without org_id whose rows point (one foreign key) at an organisation's row
  const fks = await t.rows<{ child: string; fk_col: string; parent: string; parent_col: string }>(
    `SELECT cl.relname AS child, a.attname AS fk_col, pl.relname AS parent, pa.attname AS parent_col
     FROM pg_constraint con
     JOIN pg_class cl ON cl.oid = con.conrelid
     JOIN pg_namespace n ON n.oid = cl.relnamespace AND n.nspname = current_schema()
     JOIN pg_class pl ON pl.oid = con.confrelid
     JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = con.conkey[1]
     JOIN pg_attribute pa ON pa.attrelid = con.confrelid AND pa.attnum = con.confkey[1]
     WHERE con.contype = 'f' AND array_length(con.conkey, 1) = 1
     ORDER BY cl.relname, con.conname`,
  );
  const children = new Map<string, string[]>();
  for (const f of fks) {
    if (withOrg.has(f.child) || f.child === "organisations") continue;
    const cond =
      f.parent === "organisations"
        ? `${q(f.fk_col)} = $1`
        : withOrg.has(f.parent)
          ? `${q(f.fk_col)} IN (SELECT ${q(f.parent_col)} FROM ${q(f.parent)} WHERE org_id = $1)`
          : null;
    if (cond) children.set(f.child, [...(children.get(f.child) ?? []), cond]);
  }
  for (const [table, conds] of children)
    plans.push({ table, columns: byTable.get(table) ?? [], where: conds.map((c) => `(${c})`).join(" OR ") });
  return plans.filter((p) => p.columns.length).sort((a, b) => a.table.localeCompare(b.table));
}

export async function exportOrganisation(
  ctx: AppContext,
  user: SessionUser,
  orgId: string,
  reason: string,
): Promise<{ body: Readable; filename: string }> {
  return exportOrganisationAs(ctx, staffActor(user, "super_admin"), orgId, reason);
}

/** The export itself, for PALTAS staff or the organisation's own administrator (also after a trial expired). */
export async function exportOrganisationAs(
  ctx: AppContext,
  actor: Actor,
  orgId: string,
  reason: string,
): Promise<{ body: Readable; filename: string }> {
  const { db, log } = ctx;
  if (!(await db.row("SELECT 1 FROM organisations WHERE id = $1", [orgId])))
    throw fail.notFound("Organisation not found");
  await recordAudit(db, { actor, orgId, action: "Organisation data exported", target: orgId, detail: reason });

  const out = new PassThrough();
  const write = async (chunk: string) => {
    if (out.destroyed) throw new Error("The client went away");
    if (!out.write(chunk)) await Promise.race([once(out, "drain"), once(out, "close")]);
    if (out.destroyed) throw new Error("The client went away");
  };

  void db
    .tx(async (t) => {
      await t.run("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY");
      const org = await t.row<Record<string, unknown>>("SELECT * FROM organisations WHERE id = $1", [orgId]);
      const members = await t.rows<{ userId: string; email: string; name: string; role: string; status: string }>(
        `SELECT u.id AS "userId", u.email, u.name, m.role, m.status FROM memberships m JOIN users u ON u.id = m.user_id
         WHERE m.org_id = $1 ORDER BY u.email`,
        [orgId],
      );
      await write(
        `{"format":${JSON.stringify(ops.ORG_EXPORT_FORMAT)},"exportedAt":${JSON.stringify(new Date().toISOString())},` +
          `"organisation":${JSON.stringify(org)},"members":${JSON.stringify(members)},"tables":{`,
      );
      const tables = await exportPlan(t);
      for (const [i, p] of tables.entries()) {
        await write(`${i ? "," : ""}${JSON.stringify(p.table)}:[`);
        const eventDetails = p.table === "notification_events";
        const projection = p.columns
          .map((column) =>
            eventDetails && column === "detail"
              ? `CASE WHEN notification_id IN (SELECT id FROM notifications WHERE org_id=$1 AND template_key=ANY($2::text[])) THEN 'Security email delivery status' ELSE detail END AS detail`
              : q(column),
          )
          .join(", ");
        const select = `SELECT ${projection} FROM ${q(p.table)} WHERE ${p.where} ORDER BY ctid`;
        for (let offset = 0, first = true; ; offset += BATCH) {
          const rows = await t.rows<Record<string, unknown>>(
            `${select} LIMIT ${BATCH} OFFSET ${offset}`,
            eventDetails ? [orgId, SECURITY_TEMPLATE_KEYS] : [orgId],
          );
          for (const r of rows) {
            await write(
              (first ? "" : ",") + JSON.stringify(p.table === "notifications" ? redactSecurityNotification(r) : r),
            );
            first = false;
          }
          if (rows.length < BATCH) break;
        }
        await write("]");
      }
      await write("}}");
    })
    .then(
      () => out.end(),
      (err: Error) => {
        log.warn({ err, orgId }, "Organisation export stopped");
        out.destroy(err);
      },
    );
  return { body: out, filename: `paltas-export-${orgId}.json` };
}
