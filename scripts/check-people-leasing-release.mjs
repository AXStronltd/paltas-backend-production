// Fail closed: deploying an earlier operational batch is not evidence for this enterprise specification.
import { readFile } from "node:fs/promises";
const path = new URL("../docs/people-leasing/requirements.json", import.meta.url);
const { requirements, journeys, integrationChecks, scaleEvidence } = JSON.parse(await readFile(path, "utf8"));
const statuses = new Set(["NOT STARTED", "IN PROGRESS", "IMPLEMENTED", "TESTED", "BLOCKED", "VERIFIED COMPLETE"]);
const errors = [];
if (!Array.isArray(requirements) || requirements.length !== 193) errors.push("Expected all 193 A–L requirements");
const ids = new Set();
for (const r of requirements ?? []) {
  if (ids.has(r.id)) errors.push(`Duplicate requirement ${r.id}`);
  ids.add(r.id);
  if (!statuses.has(r.status)) errors.push(`${r.id}: invalid status`);
  if (r.status !== "VERIFIED COMPLETE") errors.push(`${r.id}: ${r.status}`);
  if (!r.tests?.length || !r.verification?.startsWith("PASS ")) errors.push(`${r.id}: passing evidence required`);
  if (r.blockers?.length) errors.push(`${r.id}: dependency unresolved`);
}
if (
  !Array.isArray(journeys) ||
  journeys.length !== 15 ||
  journeys.some((j) => j.status !== "PASS" || !j.evidence?.length)
)
  errors.push("All 15 acceptance journeys require passing evidence");
if (
  !Array.isArray(integrationChecks) ||
  integrationChecks.length !== 12 ||
  integrationChecks.some((j) => j.status !== "PASS" || !j.evidence?.length)
)
  errors.push("All 12 integrations require passing evidence");
if (
  !scaleEvidence ||
  scaleEvidence.units < 100000 ||
  scaleEvidence.status !== "PASS" ||
  !scaleEvidence.evidence?.length
)
  errors.push("Measured 100,000-unit performance evidence required");
if (errors.length) {
  console.error(`People & Leasing release BLOCKED: ${errors.length} unresolved checks. No production changes made.`);
  console.error(errors.slice(0, 20).join("\n"));
  process.exitCode = 1;
} else
  console.log(
    "People & Leasing requirements and recorded acceptance gates passed. Verify the referenced evidence before release.",
  );
