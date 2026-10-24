// Retain the fingerprint independently when exporting; never trust a root supplied only inside the file being checked.
import { readFileSync } from "node:fs";
import { verifyAuditExport } from "../server/dist/core/audit/integrity.js";
const [file, root] = process.argv.slice(2);
if (!file || !root) {
  console.error("Usage: node scripts/verify-audit-export.mjs report.json RETAINED_SHA256_ROOT");
  process.exit(2);
}
try {
  const ok = verifyAuditExport(JSON.parse(readFileSync(file, "utf8")), root);
  console.log(ok ? "VERIFIED: export matches the retained fingerprint." : "FAILED: export or fingerprint differs.");
  process.exitCode = ok ? 0 : 1;
} catch {
  console.error("Cannot read a valid audit export.");
  process.exitCode = 1;
}
