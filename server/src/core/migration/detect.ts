/*
 * Detection: which entity a table probably holds, and which column means which field. Only a proposal — the person
 * confirms or changes it (mapping stage). Aliases come from three places: the field's own name and label, the
 * domain's aliases, and the source-system profile (data saved per organisation).
 */
import type { ColumnMapping, ProfileConfig } from "@paltas/contracts";
import type { EntitySpec, FieldSpec, MigrationDomain } from "./domain.js";

/** Every row needs the record's id in the source system: it is what makes re-running an import safe. */
export const SOURCE_ID = "source_record_id";
/** A documents manifest (file name → record) is read by the engine for linking documents; it imports nothing. */
export const MANIFEST = "document_manifest";
export const MANIFEST_FIELDS = ["filename", "entity", "record_ref"] as const;

export const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

const singular = (s: string) => s.replace(/ies$/, "y").replace(/s$/, "");

function fieldAliases(e: EntitySpec, f: FieldSpec | null, profile: ProfileConfig): string[] {
  if (!f) {
    const words = [e.name.replace(/_/g, " "), e.label.toLowerCase()];
    return [
      "id",
      "source id",
      "record id",
      "external id",
      "reference id",
      ...words.flatMap((w) => [`${w} id`, `${w} ref`, `${w} no`, `${w} number`, `${w} code`]),
      ...(e.idAliases ?? []),
      ...(profile.aliases[e.name]?.[SOURCE_ID] ?? []),
    ].map(norm);
  }
  const base = f.name.replace(/_ref$/, "").replace(/_/g, " ");
  const own = [f.name.replace(/_/g, " "), base, f.label];
  if (f.type === "ref") own.push(`${base} id`, `${base} ref`, `${base} code`, `${base} no`, `${base} number`);
  return [...own, ...(f.aliases ?? []), ...(profile.aliases[e.name]?.[f.name] ?? [])].map(norm);
}

/** Propose a column → field mapping for an entity (each field used at most once). */
export function proposeMapping(e: EntitySpec, headers: string[], profile: ProfileConfig): ColumnMapping[] {
  const out: ColumnMapping[] = [];
  const used = new Set<string>();
  const candidates: [string, string[]][] = [
    [SOURCE_ID, fieldAliases(e, null, profile)],
    ...e.fields.map((f) => [f.name, fieldAliases(e, f, profile)] as [string, string[]]),
  ];
  for (const h of headers) {
    const n = norm(h);
    const hit = candidates.find(([name, aliases]) => !used.has(name) && aliases.includes(n));
    if (!hit) continue;
    used.add(hit[0]);
    out.push({ source: h, field: hit[0], transforms: [{ op: "trim" }] });
  }
  return out;
}

function isManifest(headers: string[]): boolean {
  const n = headers.map(norm);
  return (
    n.some((h) => ["filename", "file name", "file", "document"].includes(h)) && n.some((h) => h.includes("entity"))
  );
}

export function manifestMapping(headers: string[]): ColumnMapping[] {
  const pick = (names: string[]) => headers.find((h) => names.includes(norm(h)));
  const map: [string, string | undefined][] = [
    ["filename", pick(["filename", "file name", "file", "document"])],
    ["entity", pick(["entity", "record type", "linked entity", "entity type"])],
    ["record_ref", pick(["record id", "record ref", "reference", "source record id", "record"])],
  ];
  return map.filter((m): m is [string, string] => !!m[1]).map(([field, source]) => ({ source, field, transforms: [] }));
}

/** The entity a table most likely holds, with a confidence between 0 and 1. */
export function guessEntity(
  d: MigrationDomain,
  tableName: string,
  fileName: string,
  headers: string[],
  profile: ProfileConfig,
): { entity: string | null; confidence: number; mapping: ColumnMapping[] } {
  const saved = profile.templates?.find(
    (t) => t.headers.length === headers.length && t.headers.every((h, i) => h === headers[i]),
  );
  if (saved) {
    const entity = d.entities.find((e) => e.name === saved.entity);
    if (
      entity &&
      saved.columns.every(
        (c) => headers.includes(c.source) && (c.field === SOURCE_ID || entity.fields.some((f) => f.name === c.field)),
      )
    )
      return { entity: saved.entity, confidence: 1, mapping: saved.columns };
  }
  if (isManifest(headers)) return { entity: MANIFEST, confidence: 1, mapping: manifestMapping(headers) };
  const names = norm(`${tableName} ${fileName}`);
  let best: { entity: string | null; confidence: number; mapping: ColumnMapping[] } = {
    entity: null,
    confidence: 0,
    mapping: [],
  };
  for (const e of d.entities) {
    const mapping = proposeMapping(e, headers, profile);
    const fields = new Set(mapping.map((m) => m.field));
    const required = e.fields.filter((f) => f.required);
    const requiredShare = required.length ? required.filter((f) => fields.has(f.name)).length / required.length : 1;
    const columnShare = headers.length ? mapping.length / headers.length : 0;
    const hints = [...e.hints, ...(profile.entityHints[e.name] ?? [])].map(norm);
    const named =
      hints.some((h) => h && names.includes(h)) ||
      names.split(" ").some((w) => singular(w) === e.name.replace(/_/g, "") || singular(w) === norm(e.label));
    const confidence = Math.min(1, 0.45 * requiredShare + 0.3 * columnShare + (named ? 0.35 : 0));
    if (confidence > best.confidence)
      best = { entity: e.name, confidence: Math.round(confidence * 100) / 100, mapping };
  }
  return best.confidence >= 0.4 ? best : { entity: null, confidence: best.confidence, mapping: [] };
}
