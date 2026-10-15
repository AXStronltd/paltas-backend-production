/*
 * Reconciliation: the source (rows meant to exist in PALTAS after the import) against what PALTAS now holds,
 * looked up by source key — so the numbers are independent of the import code that wrote them.
 *   counts per entity · money totals per money field · references set per reference field · documents ·
 *   the ledger: what the postings should be (recomputed from the source rows) against the posted journals,
 *   and the trial balance still balancing.
 */
import type { Reconciliation } from "@paltas/contracts";
import type { Db } from "../../db/database.js";
import type { LedgerService } from "../ledger/ledger.service.js";
import { MANIFEST } from "./detect.js";
import { columnOf, type MigrationDomain, type PostingRow } from "./domain.js";
import { documentKey } from "./importer.js";
import type { JobRow } from "./migration.repo.js";

type Line = Reconciliation["counts"][number];
const line = (check: string, entity: string | null, source: number, destination: number): Line => ({
  check,
  entity,
  source,
  destination,
  difference: destination - source,
  ok: source === destination,
});

export async function reconcileJob(
  t: Db,
  job: JobRow,
  domain: MigrationDomain,
  ledger: LedgerService,
  at: string,
): Promise<Reconciliation> {
  const rows = await t.rows<{
    entity: string;
    source_record_id: string;
    status: string;
    data: { values: Record<string, unknown> } | null;
  }>(
    `SELECT DISTINCT ON (entity, source_record_id) entity, source_record_id, status, data FROM mig_rows
     WHERE job_id = $1 AND entity IS NOT NULL AND entity <> $2 AND status IN ('valid', 'imported', 'already_present')
     ORDER BY entity, source_record_id, id`,
    [job.id, MANIFEST],
  );
  const counts: Line[] = [];
  const money: Line[] = [];
  const relationships: Line[] = [];
  for (const spec of domain.entities) {
    const src = rows.filter((r) => r.entity === spec.name);
    if (!src.length) continue;
    const moneyFields = spec.fields.filter((f) => f.type === "money");
    const refFields = spec.fields.filter((f) => f.type === "ref");
    const fixed = Object.entries(spec.fixed ?? {});
    const dest = (await t.row<Record<string, number>>(
      `SELECT count(*)::int AS n
         ${moneyFields.map((f, i) => `, COALESCE(sum(${columnOf(f)}), 0)::bigint AS m${i}`).join("")}
         ${refFields.map((f, i) => `, count(${columnOf(f)})::int AS r${i}`).join("")}
       FROM ${spec.table} WHERE org_id = $1 AND source_system = $2 AND source_record_id = ANY($3)
       ${fixed.map(([c], i) => `AND ${c} = $${i + 4}`).join(" ")}`,
      [job.org_id, job.source_system, src.map((r) => r.source_record_id), ...fixed.map(([, v]) => v)],
    )) as Record<string, number>;
    counts.push(line("Records", spec.name, src.length, dest.n ?? 0));
    moneyFields.forEach((f, i) =>
      money.push(
        line(
          `${f.label} total`,
          spec.name,
          src.reduce((s, r) => s + (Number(r.data?.values[f.name]) || 0), 0),
          dest[`m${i}`] ?? 0,
        ),
      ),
    );
    refFields.forEach((f, i) =>
      relationships.push(
        line(`${f.label} linked`, spec.name, src.filter((r) => r.data?.values[f.name]).length, dest[`r${i}`] ?? 0),
      ),
    );
  }
  // one document record per file and what it is linked to (the same key the import uses)
  const docRows = await t.rows<{ sha256: string; status: string; link_entity: string | null; link_id: string | null }>(
    `SELECT d.sha256, d.status, d.link_entity,
       COALESCE(d.link_target_id, (SELECT r.target_id FROM mig_rows r WHERE r.job_id = d.job_id AND r.entity = d.link_entity
         AND r.source_record_id = d.link_source_id AND r.target_id IS NOT NULL LIMIT 1)) AS link_id
     FROM mig_documents d WHERE d.job_id = $1 AND d.status IN ('linked', 'unlinked')`,
    [job.id],
  );
  const docs = [
    ...new Map(
      docRows.map((x) => {
        const linked = x.status === "linked";
        return [documentKey(x.sha256, linked ? x.link_entity : null, linked ? x.link_id : null), x] as const;
      }),
    ).entries(),
  ].map(([key, x]) => ({ key, status: x.status }));
  if (docs.length) {
    const d = await t.row<{ n: number; linked: number }>(
      `SELECT count(*)::int AS n, count(link_id)::int AS linked FROM ${domain.documentTable}
       WHERE org_id = $1 AND source_system = $2 AND source_record_id = ANY($3)`,
      [job.org_id, job.source_system, docs.map((x) => x.key)],
    );
    counts.push(line("Documents", "document", docs.length, d?.n ?? 0));
    relationships.push(
      line(
        "Documents linked to a record",
        "document",
        docs.filter((x) => x.status === "linked").length,
        d?.linked ?? 0,
      ),
    );
  }

  // ledger: expected postings from the rows this job created, against the journals of its batches
  const ledgerLines: Line[] = [];
  const expected = new Map<string, number>();
  for (const spec of domain.entities) {
    const created = await t.rows<{
      source_record_id: string;
      target_id: string;
      data: { values: Record<string, unknown> };
    }>(
      "SELECT source_record_id, target_id, data FROM mig_rows WHERE job_id = $1 AND entity = $2 AND status = 'imported'",
      [job.id, spec.name],
    );
    const posting = domain.posting?.(
      spec.name,
      created.map((r): PostingRow => ({ targetId: r.target_id, sourceId: r.source_record_id, values: r.data.values })),
      job.cutover_date,
    );
    for (const l of posting?.lines ?? [])
      expected.set(l.account, (expected.get(l.account) ?? 0) + l.debitMinor - l.creditMinor);
  }
  const posted = await t.rows<{ account_code: string; net: number }>(
    `SELECT l.account_code, sum(l.debit_minor - l.credit_minor)::bigint AS net
     FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id AND e.status = 'posted'
     WHERE e.id IN (SELECT journal_id FROM mig_batches WHERE job_id = $1 AND journal_id IS NOT NULL
                    UNION SELECT reversal_journal_id FROM mig_batches WHERE job_id = $1 AND reversal_journal_id IS NOT NULL)
     GROUP BY l.account_code`,
    [job.id],
  );
  const accounts = new Set([...expected.keys(), ...posted.map((p) => p.account_code)]);
  for (const a of [...accounts].sort())
    ledgerLines.push(
      line(
        `Account ${a} (debit − credit)`,
        null,
        expected.get(a) ?? 0,
        posted.find((p) => p.account_code === a)?.net ?? 0,
      ),
    );
  const tb = await ledger.trialBalance(job.org_id, "9999-12-31");
  ledgerLines.push(line("Trial balance difference", null, 0, tb.totals.debitMinor - tb.totals.creditMinor));

  const all = [...counts, ...money, ...relationships, ...ledgerLines];
  const mismatches = all
    .filter((l) => !l.ok)
    .map((l) => `${l.entity ? l.entity + ": " : ""}${l.check} — source ${l.source}, PALTAS ${l.destination}`);
  return { at, ok: mismatches.length === 0, counts, money, relationships, ledger: ledgerLines, mismatches };
}
