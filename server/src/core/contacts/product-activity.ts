/** Internal, transaction-local event projection. No public dispatch endpoint or external side effects. */
import type { contacts as C, Product } from "@paltas/contracts";
import type { Db } from "../../db/database.js";
import { fail } from "../../http/errors.js";
import { newId } from "../../lib/ids.js";
import { toActivity, type ActivityRow } from "./contacts.repo.js";
const SOURCES = {
  "property.lease.activated": {
    product: "property",
    kind: "lease",
    refType: "lease",
    sql: "SELECT tenant_id AS contact_id FROM pm_leases WHERE org_id=$1 AND id=$2 AND status='active'",
  },
  "property.payment.recorded": {
    product: "property",
    kind: "payment",
    refType: "payment",
    sql: "SELECT tenant_id AS contact_id FROM pm_payments WHERE org_id=$1 AND id=$2 AND journal_id IS NOT NULL",
  },
  "agency.stay.completed": {
    product: "agency",
    kind: "system",
    refType: "agency_stay",
    sql: "SELECT contact_id FROM agency_stays WHERE org_id=$1 AND id=$2 AND status='completed'",
  },
} as const;
export type ProductActivityEvent = keyof typeof SOURCES;
export async function projectProductActivity(
  t: Db,
  input: {
    orgId: string;
    contactId: string;
    eventType: ProductActivityEvent;
    recordId: string;
    text: string;
    by: string | null;
  },
): Promise<C.Activity> {
  const spec = SOURCES[input.eventType];
  if (!spec) throw fail.invalid("Unsupported product activity event");
  if (!input.text.trim() || input.text.length > 2000)
    throw fail.invalid("Product activity requires a summary of at most 2000 characters");
  const source = await t.row<{ contact_id: string | null }>(spec.sql, [input.orgId, input.recordId]);
  if (!source || source.contact_id !== input.contactId)
    throw fail.notFound("The source record does not belong to this organisation and contact");
  if (!(await t.row("SELECT id FROM contacts WHERE org_id=$1 AND id=$2", [input.orgId, input.contactId])))
    throw fail.notFound("Contact not found");
  const key = input.eventType + ":" + input.recordId;
  // Serialise concurrent deliveries before comparing existing provenance. Caller owns the business transaction.
  await t.run("SELECT pg_advisory_xact_lock(hashtext($1))", ["contact-event:" + input.orgId + ":" + key]);
  const before = await t.row<ActivityRow>(
    "SELECT * FROM contact_activities WHERE org_id=$1 AND source_product=$2 AND event_key=$3",
    [input.orgId, spec.product, key],
  );
  if (before) {
    if (
      before.contact_id !== input.contactId ||
      before.ref_id !== input.recordId ||
      before.event_type !== input.eventType
    )
      throw fail.conflict("Event identity conflicts with an existing activity");
    return toActivity(before); // Preserve original author/time/summary on replay.
  }
  const saved = await t.row<ActivityRow>(
    `INSERT INTO contact_activities(id,org_id,contact_id,kind,text,ref_type,ref_id,by_user,source_product,event_type,event_key)
  VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
    [
      newId("act"),
      input.orgId,
      input.contactId,
      spec.kind,
      input.text,
      spec.refType,
      input.recordId,
      input.by,
      spec.product,
      input.eventType,
      key,
    ],
  );
  if (!saved) throw new Error("Could not record product activity");
  return toActivity(saved);
}
export const PRODUCT_ACTIVITY_ORIGINS: readonly Product[] = ["property", "agency"];
