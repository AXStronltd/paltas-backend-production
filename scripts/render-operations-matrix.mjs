import { readFile, writeFile } from "node:fs/promises";
const data = JSON.parse(await readFile(new URL("../docs/operations/requirements.json", import.meta.url), "utf8"));
const cell = (v) =>
  String(v ?? "")
    .replaceAll("|", "/")
    .replaceAll("\n", " ");
const rows = [
  "# Operations completion matrix",
  "",
  "Updated 25 October 2026. **The full Operations programme is not complete.**",
  "",
  "This table is rendered from `operations/requirements.json`. NOT STARTED means requirement-level acceptance is pending; it does not assert that existing functionality is missing. IN PROGRESS may include a released, verified subset. The approved original specification and all 12 acceptance journeys remain authoritative.",
  "",
  "| ID | Module | Requirement | Status | Frontend | Backend | Database | Dependencies | Tests / verification | Blockers |",
  "|---|---|---|---|---|---|---|---|---|---|",
];
for (const r of data.requirements)
  rows.push(
    "| " +
      [
        r.id,
        r.module,
        r.description,
        r.status,
        r.frontend,
        r.backend,
        r.database,
        r.dependencies.join(", "),
        [...r.tests, r.verification].join("; "),
        r.blockers.join("; ") || "Full applicable lifecycle acceptance remains open",
      ]
        .map(cell)
        .join(" | ") +
      " |",
  );
rows.push(
  "",
  "## Released operational corrections",
  "",
  ...data.releases.map((r) => `- ${r.scope}: backend ${r.backend}, frontend ${r.frontend} — ${r.status}.`),
  "",
  "## Reuse and integration",
  "",
  "- Property maintenance, inspection findings, quotations, purchase-order approvals, supplier bills and owner-ledger postings remain in their existing services.",
  "- Hotel stock valuation, receipts, supplier matching, housekeeping and automation are existing implementations to reuse.",
  "- Developer procurement and supplier controls remain in their existing services.",
  "- Hotel preventive-plan controls under verification reuse existing automation and Administration → Night audit and messages settings. They do not create a second scheduler or financial engine.",
  "",
  "## Acceptance and external dependencies",
  "",
  "All 12 cross-product acceptance journeys, target-scale performance, recovery and financial reconciliation remain separately tracked. Hardware, live payment execution, screening, signatures and jurisdiction-specific rules require verified configuration; never substitute fake live status.",
  "",
);
await writeFile(new URL("../docs/operations-completion-matrix.md", import.meta.url), rows.join("\n"));
