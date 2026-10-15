// SQL for folios and folio lines, and their API shape.
import type { hotel } from "@paltas/contracts";
import type { Db } from "../../../db/database.js";
import { fail } from "../../../http/errors.js";

export interface FolioRow {
  id: string;
  org_id: string;
  property_id: string;
  number: string;
  reservation_id: string | null;
  stay_id: string | null;
  group_block_id: string | null;
  name: string;
  payer: "guest" | "company";
  corporate_account_id: string | null;
  status: "open" | "closed";
  blocked: boolean;
  blocked_reason: string | null;
}

export interface LineRow {
  id: string;
  folio_id: string;
  business_date: string;
  kind: hotel.FolioLineOut["kind"];
  department: hotel.HotelDepartment | null;
  description: string;
  net_minor: number;
  service_minor: number;
  vat_minor: number;
  levy_minor: number;
  total_minor: number;
  method: hotel.PaymentMethod | null;
  reference: string | null;
  stay_id: string | null;
  night_date: string | null;
  voids_line_id: string | null;
  void_approved_by: string | null;
  journal_id: string | null;
  created_by: string | null;
  voided_by: string | null;
}

export async function folioRow(db: Db, propertyId: string, id: string, lock = false): Promise<FolioRow> {
  const f = await db.row<FolioRow>(
    `SELECT * FROM hotel_folios WHERE property_id = $1 AND id = $2${lock ? " FOR UPDATE" : ""}`,
    [propertyId, id],
  );
  if (!f) throw fail.notFound("Folio not found");
  return f;
}

export async function lines(db: Db, folioId: string): Promise<LineRow[]> {
  return db.rows<LineRow>(
    `SELECT l.*, v.id AS voided_by FROM hotel_folio_lines l
     LEFT JOIN hotel_folio_lines v ON v.voids_line_id = l.id
     WHERE l.folio_id = $1 ORDER BY l.seq`,
    [folioId],
  );
}

export async function balance(db: Db, folioId: string): Promise<number> {
  const r = await db.row<{ n: number }>(
    "SELECT COALESCE(sum(total_minor), 0)::bigint AS n FROM hotel_folio_lines WHERE folio_id = $1",
    [folioId],
  );
  return r?.n ?? 0;
}

export const toLine = (l: LineRow): hotel.FolioLineOut => ({
  id: l.id,
  date: l.business_date,
  kind: l.kind,
  department: l.department,
  description: l.description,
  netMinor: l.net_minor,
  serviceChargeMinor: l.service_minor,
  vatMinor: l.vat_minor,
  levyMinor: l.levy_minor,
  totalMinor: l.total_minor,
  method: l.method,
  reference: l.reference,
  voidsLineId: l.voids_line_id,
  voidedBy: l.voided_by,
  voidApprovedBy: l.void_approved_by,
  journalId: l.journal_id,
  createdBy: l.created_by,
});

export async function toFolio(db: Db, f: FolioRow): Promise<hotel.Folio> {
  const ls = await lines(db, f.id);
  const charges = ls.filter((l) => l.total_minor > 0).reduce((n, l) => n + l.total_minor, 0);
  const credits = ls.filter((l) => l.total_minor < 0).reduce((n, l) => n - l.total_minor, 0);
  return {
    id: f.id,
    number: f.number,
    propertyId: f.property_id,
    reservationId: f.reservation_id,
    stayId: f.stay_id,
    groupBlockId: f.group_block_id,
    name: f.name,
    payer: f.payer,
    corporateAccountId: f.corporate_account_id,
    status: f.status,
    blocked: f.blocked,
    blockedReason: f.blocked_reason,
    lines: ls.map(toLine),
    chargesMinor: charges,
    creditsMinor: credits,
    balanceMinor: charges - credits,
  };
}
