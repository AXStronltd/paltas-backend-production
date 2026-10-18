/*
 * Loading and shaping the dev_* records every Development area shares: projects, units, buyers (with who may see
 * them), contracts with their instalments, documents, members and tasks. Every lookup is by organisation: another
 * organisation's id answers "not found". Records brought over by data migration (source_system set) load the same
 * way as records made in PALTAS.
 */
import type { development, Role, z } from "@paltas/contracts";
import { roleCan } from "@paltas/contracts";
import type { OrgScope } from "../../../core/access/org-access.js";
import type { Db } from "../../../db/database.js";
import { fail } from "../../../http/errors.js";
import { newId } from "../../../lib/ids.js";
import { can } from "./access.js";

type Out<T extends z.ZodType> = z.input<T>;

// ------------------------------------------------------------------ projects and units
export interface ProjectRow {
  id: string;
  org_id: string;
  name: string;
  code: string | null;
  location: string | null;
  status: string | null;
  stage: string | null;
  progress_pct: number;
  start_date: string | null;
  end_date: string | null;
  forecast_end_date: string | null;
  source_system: string | null;
}

export async function findProject(db: Db, orgId: string, id: string, lock = false): Promise<ProjectRow> {
  const p = await db.row<ProjectRow>(
    `SELECT * FROM dev_projects WHERE org_id = $1 AND id = $2${lock ? " FOR UPDATE" : ""}`,
    [orgId, id],
  );
  if (!p) throw fail.notFound("Project not found");
  return p;
}

export interface UnitRow {
  id: string;
  org_id: string;
  project_id: string;
  building_id: string | null;
  floor_id: string | null;
  unit_no: string;
  type: string | null;
  bedrooms: number | null;
  area_sqm: number | null;
  list_price_minor: number | null;
  status: z.infer<typeof development.UnitStatus>;
  source_system: string | null;
}

/** Units without a status (possible in migrated data) are on sale. */
export const UNIT_SELECT = "SELECT u.*, COALESCE(u.status, 'available') AS status FROM dev_units u";

export async function findUnit(db: Db, orgId: string, id: string, lock = false): Promise<UnitRow> {
  const u = await db.row<UnitRow>(`${UNIT_SELECT} WHERE u.org_id = $1 AND u.id = $2${lock ? " FOR UPDATE OF u" : ""}`, [
    orgId,
    id,
  ]);
  if (!u) throw fail.notFound("Unit not found");
  return u;
}

export const toUnit = (u: UnitRow): Out<typeof development.Unit> => ({
  id: u.id,
  projectId: u.project_id,
  buildingId: u.building_id,
  floorId: u.floor_id,
  unitNo: u.unit_no,
  type: u.type,
  bedrooms: u.bedrooms,
  areaSqm: u.area_sqm,
  listPriceMinor: u.list_price_minor,
  status: u.status,
  migrated: u.source_system !== null,
});

// ------------------------------------------------------------------ buyers
export interface BuyerRow {
  id: string;
  org_id: string;
  kind: string;
  name: string;
  email: string | null;
  phone: string | null;
  national_id: string | null;
  party_type: string | null;
  address: string | null;
  source: string | null;
  agent_user_id: string | null;
  contact_id: string | null;
  status: "active" | "lost" | "merged";
  merged_into: string | null;
  next_follow_up: string | null;
  source_system: string | null;
  stage: string;
  pipeline_stage: string | null;
  pipeline_version: number;
}

/** Where a buyer is in the journey, from enquiry to after-sales (the workspace's pipeline stages). */
export const STAGE_SQL = `CASE
  WHEN EXISTS (SELECT 1 FROM dev_tasks t WHERE t.buyer_id = c.id AND t.category = 'aftersales') THEN 'after_sales'
  WHEN EXISTS (SELECT 1 FROM dev_contracts k JOIN dev_units u ON u.id = k.unit_id
               WHERE k.buyer_id = c.id AND u.status = 'handed_over') THEN 'handed_over'
  WHEN EXISTS (SELECT 1 FROM dev_contracts k WHERE k.buyer_id = c.id AND k.status IS DISTINCT FROM 'cancelled'
               AND EXISTS (SELECT 1 FROM dev_payments p WHERE p.contract_id = k.id)) THEN 'paying_instalments'
  WHEN EXISTS (SELECT 1 FROM dev_contracts k WHERE k.buyer_id = c.id AND k.status IS DISTINCT FROM 'cancelled') THEN 'contracted'
  WHEN EXISTS (SELECT 1 FROM dev_reservations r WHERE r.buyer_id = c.id AND r.status IN ('awaiting_approval', 'active')) THEN 'reserved'
  WHEN EXISTS (SELECT 1 FROM dev_offers o WHERE o.buyer_id = c.id AND o.status = 'accepted') THEN 'offer_accepted'
  WHEN EXISTS (SELECT 1 FROM dev_offers o WHERE o.buyer_id = c.id
               AND o.status IN ('draft', 'awaiting_approval', 'submitted', 'counteroffer')) THEN 'negotiating'
  WHEN c.pipeline_stage IS NOT NULL THEN c.pipeline_stage
  WHEN EXISTS (SELECT 1 FROM dev_correspondence x WHERE x.buyer_id = c.id) THEN 'contacted'
  ELSE 'enquiry' END`;

export const BUYER_SELECT = `SELECT c.*, ${STAGE_SQL} AS stage FROM dev_contacts c`;

/** May this person see this buyer? Everyone with developer.buyers.all; a sales agent only their own buyers. */
export const seesBuyer = (s: OrgScope, b: { agent_user_id: string | null }): boolean =>
  can(s, "developer.buyers.all") || b.agent_user_id === s.userId;

export async function findBuyer(db: Db, s: OrgScope, id: string, lock = false): Promise<BuyerRow> {
  if (lock) await db.run("SELECT 1 FROM dev_contacts WHERE org_id = $1 AND id = $2 FOR UPDATE", [s.orgId, id]);
  const b = await db.row<BuyerRow>(`${BUYER_SELECT} WHERE c.org_id = $1 AND c.id = $2 AND c.kind = 'buyer'`, [
    s.orgId,
    id,
  ]);
  // a buyer this person may not see looks exactly like one that does not exist
  if (!b || !seesBuyer(s, b)) throw fail.notFound("Buyer not found");
  return b;
}

export const toBuyer = (b: BuyerRow): Out<typeof development.Buyer> => ({
  id: b.id,
  name: b.name,
  email: b.email,
  phone: b.phone,
  nationalId: b.national_id,
  partyType: b.party_type,
  address: b.address,
  source: b.source,
  agentUserId: b.agent_user_id,
  contactId: b.contact_id,
  status: b.status,
  mergedInto: b.merged_into,
  stage: b.stage,
  pipelineVersion: b.pipeline_version,
  nextFollowUp: b.next_follow_up,
  migrated: b.source_system !== null,
});

// ------------------------------------------------------------------ contracts and instalments
export interface ContractRow {
  id: string;
  org_id: string;
  unit_id: string;
  buyer_id: string;
  reservation_id: string | null;
  offer_id: string | null;
  number: string | null;
  date: string;
  price_minor: number;
  status: string | null;
  deposit_bp: number | null;
  instalments_bp: number | null;
  months: number | null;
  completion_bp: number | null;
  signed_document_id: string | null;
  source_system: string | null;
  project_id: string;
  agent_user_id: string | null;
  unit_status: string;
}

export interface InstalmentRow {
  id: string;
  contract_id: string;
  seq: number;
  due_date: string;
  amount_minor: number;
  description: string | null;
  billed: boolean;
  receivable_minor: number;
  paid_minor: number;
  source_system: string | null;
}

const CONTRACT_SELECT = `SELECT k.*, u.project_id, c.agent_user_id, COALESCE(u.status, 'available') AS unit_status
  FROM dev_contracts k JOIN dev_units u ON u.id = k.unit_id JOIN dev_contacts c ON c.id = k.buyer_id`;

export async function findContract(db: Db, s: OrgScope, id: string, lock = false): Promise<ContractRow> {
  if (lock) await db.run("SELECT 1 FROM dev_contracts WHERE org_id = $1 AND id = $2 FOR UPDATE", [s.orgId, id]);
  const k = await db.row<ContractRow>(`${CONTRACT_SELECT} WHERE k.org_id = $1 AND k.id = $2`, [s.orgId, id]);
  if (!k || !seesBuyer(s, k)) throw fail.notFound("Contract not found");
  return k;
}

export async function contractRows(db: Db, s: OrgScope, where: string, params: unknown[]): Promise<ContractRow[]> {
  const rows = await db.rows<ContractRow>(`${CONTRACT_SELECT} WHERE k.org_id = $1 ${where} ORDER BY k.date, k.id`, [
    s.orgId,
    ...params,
  ]);
  return rows.filter((k) => seesBuyer(s, k));
}

/** A contract's instalments with what is paid on each (allocations of receipts), oldest first. */
export async function instalments(db: Db, contractId: string, lock = false): Promise<InstalmentRow[]> {
  if (lock)
    await db.run("SELECT 1 FROM dev_instalments WHERE contract_id = $1 ORDER BY seq, due_date FOR UPDATE", [
      contractId,
    ]);
  return db.rows<InstalmentRow>(
    `SELECT i.*, COALESCE((SELECT sum(a.amount_minor) FROM dev_payment_allocations a WHERE a.instalment_id = i.id), 0)::bigint
       AS paid_minor
     FROM dev_instalments i WHERE i.contract_id = $1 ORDER BY i.due_date, i.seq, i.id`,
    [contractId],
  );
}

export const toInstalment = (i: InstalmentRow): Out<typeof development.Instalment> => ({
  id: i.id,
  seq: i.seq,
  dueDate: i.due_date,
  description: i.description,
  amountMinor: i.amount_minor,
  paidMinor: i.paid_minor,
  openMinor: Math.max(0, i.amount_minor - i.paid_minor),
  receivableMinor: i.receivable_minor,
});

export async function toContract(db: Db, k: ContractRow): Promise<development.Contract> {
  const inst = await instalments(db, k.id);
  const plan =
    k.deposit_bp !== null && k.instalments_bp !== null && k.months !== null && k.completion_bp !== null
      ? { depositBp: k.deposit_bp, instalmentsBp: k.instalments_bp, months: k.months, completionBp: k.completion_bp }
      : null;
  return {
    id: k.id,
    number: k.number,
    unitId: k.unit_id,
    buyerId: k.buyer_id,
    reservationId: k.reservation_id,
    offerId: k.offer_id,
    date: k.date,
    priceMinor: k.price_minor,
    status: k.status,
    plan,
    signedDocumentId: k.signed_document_id,
    instalments: inst.map(toInstalment),
    handedOver: k.unit_status === "handed_over",
    migrated: k.source_system !== null,
  };
}

/** A live contract (not cancelled) can take payments, billing and a handover. */
export const isLive = (k: { status: string | null }): boolean => k.status !== "cancelled";

/**
 * Instalments a data migration carried into 1170 Buyer receivables as an opening balance (due by the cut-over and
 * unpaid) are marked billed once, with no new posting: the receivable is already on the ledger.
 */
export async function adoptOpeningArrears(t: Db, orgId: string, contractId: string): Promise<void> {
  const ob = await t.row<{ as_of: string }>(
    "SELECT max(as_of)::text AS as_of FROM dev_opening_balances WHERE org_id = $1 AND contract_id = $2 AND kind = 'buyer_receivable'",
    [orgId, contractId],
  );
  if (!ob?.as_of) return;
  for (const i of await instalments(t, contractId, true)) {
    if (i.billed || i.due_date > ob.as_of) continue;
    await t.run("UPDATE dev_instalments SET billed = true, receivable_minor = $2 WHERE id = $1", [
      i.id,
      Math.max(0, i.amount_minor - i.paid_minor),
    ]);
  }
}

// ------------------------------------------------------------------ documents, members, numbers
export async function requireDocument(db: Db, orgId: string, id: string): Promise<void> {
  const d = await db.row("SELECT 1 FROM dev_documents WHERE org_id = $1 AND id = $2", [orgId, id]);
  if (!d) throw fail.invalid("Unknown document: record the document first");
}

/** Link a document record to what it is evidence for (only if it is not linked to something else yet). */
export async function linkDocument(db: Db, orgId: string, id: string, entity: string, linkId: string): Promise<void> {
  await db.run(
    "UPDATE dev_documents SET link_entity = $3, link_id = $4 WHERE org_id = $1 AND id = $2 AND link_id IS NULL",
    [orgId, id, entity, linkId],
  );
}

/** An active member of the organisation whose role works in Development (and, if given, has this capability). */
export async function requireMember(
  db: Db,
  orgId: string,
  userId: string,
  capability: Parameters<typeof roleCan>[1] = "developer.work",
): Promise<Role> {
  const m = await db.row<{ role: Role }>(
    "SELECT role FROM memberships WHERE org_id = $1 AND user_id = $2 AND status = 'active'",
    [orgId, userId],
  );
  if (!m || !roleCan(m.role, capability)) throw fail.invalid("Pick a member of your organisation who can do this work");
  return m.role;
}

export interface TaskInput {
  title: string;
  description?: string;
  dueDate: string;
  priority?: "low" | "normal" | "high" | "urgent";
  category: "sales" | "finance" | "aftersales" | "site" | "general";
  assignee: string;
  createdBy: string | null;
  buyerId?: string | null;
  unitId?: string | null;
  projectId?: string | null;
  contractId?: string | null;
  /** Automatic tasks: the same key never creates a second task. */
  key?: string;
}

export async function createTask(t: Db, orgId: string, i: TaskInput): Promise<string> {
  if (i.key) {
    const ex = await t.row<{ id: string }>("SELECT id FROM dev_tasks WHERE org_id = $1 AND key = $2", [orgId, i.key]);
    if (ex) return ex.id;
  }
  const id = newId("dtk");
  await t.run(
    `INSERT INTO dev_tasks (id, org_id, title, description, due_date, priority, status, category, assignee_user_id,
       created_by, buyer_id, unit_id, project_id, contract_id, key)
     VALUES ($1, $2, $3, $4, $5, $6, 'open', $7, $8, $9, $10, $11, $12, $13, $14)`,
    [
      id,
      orgId,
      i.title,
      i.description ?? "",
      i.dueDate,
      i.priority ?? "normal",
      i.category,
      i.assignee,
      i.createdBy,
      i.buyerId ?? null,
      i.unitId ?? null,
      i.projectId ?? null,
      i.contractId ?? null,
      i.key ?? null,
    ],
  );
  return id;
}

/** Complete the open automatic task with this key, if any. */
export async function closeTask(t: Db, orgId: string, key: string, userId: string, note: string): Promise<void> {
  await t.run(
    `UPDATE dev_tasks SET status = 'done', done_at = now(), done_by = $3, note = $4
     WHERE org_id = $1 AND key = $2 AND status = 'open'`,
    [orgId, key, userId, note],
  );
}

/** Basis points of an amount, in whole minor units. */
export const bpOf = (amount: number, bp: number): number => Math.round((amount * bp) / 10_000);

/** Money for a quantity at a unit price (quantities may have three decimals). */
export const lineAmount = (qty: number, unitPriceMinor: number): number => Math.round(qty * unitPriceMinor);
