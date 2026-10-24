/** Portable audit exports. A separately retained root is required to detect wholesale replacement. */
import { createHash, timingSafeEqual } from "node:crypto";
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]";
  if (typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    return (
      "{" +
      Object.keys(value)
        .sort()
        .map((k) => JSON.stringify(k) + ":" + canonicalJson((value as Record<string, unknown>)[k]))
        .join(",") +
      "}"
    );
  }
  throw new Error("Audit export must contain finite JSON values");
}
const hash = (v: unknown) => createHash("sha256").update(canonicalJson(v)).digest("hex");
export function auditExport(orgId: string, entries: Record<string, unknown>[]) {
  const header = {
    format: "paltas-audit-export-v1",
    orgId,
    count: entries.length,
    firstId: entries[0]?.id ?? null,
    lastId: entries.at(-1)?.id ?? null,
  };
  let previous = hash(header);
  const records = entries.map((entry) => {
    const digest = hash({ previous, entry });
    previous = digest;
    return { entry, hash: digest };
  });
  return { header, records, root: previous };
}
export function verifyAuditExport(value: unknown, retainedRoot: string): boolean {
  try {
    if (!/^[0-9a-f]{64}$/.test(retainedRoot)) return false;
    const data = value as ReturnType<typeof auditExport>;
    if (data.header.format !== "paltas-audit-export-v1" || !Array.isArray(data.records)) return false;
    const rebuilt = auditExport(
      data.header.orgId,
      data.records.map((r) => r.entry),
    );
    if (canonicalJson(rebuilt) !== canonicalJson(data)) return false;
    return timingSafeEqual(Buffer.from(rebuilt.root, "hex"), Buffer.from(retainedRoot, "hex"));
  } catch {
    return false;
  }
}
