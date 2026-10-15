/*
 * Real Estate Development as a migration target: every record a developer keeps in spreadsheets or other software,
 * in dependency order, with the rules that make the books agree:
 *
 *   project → phase → building → floor → unit → buyer → reservation → contract → amendment → instalment
 *   → payment (receipt / refund) → allocation → opening balance;   supplier / contractor → purchase / work order;
 *   milestones, handovers, defects, investors, disputes, correspondence; documents (metadata, linked to records).
 *
 * Opening balances post to the ONE ledger at the cut-over date, one journal per import batch:
 *   buyer_receivable   Dr 1170 Buyer receivables          Cr 3900 Opening balance equity
 *   buyer_deposit      Dr 3900 Opening balance equity     Cr 2400 Buyer deposits held
 *   supplier_payable   Dr 3900 Opening balance equity     Cr 2000 Accounts payable (core account)
 */
import type {
  CheckContext,
  CheckIssue,
  CheckRow,
  EntitySpec,
  FieldSpec,
  MigrationDomain,
  PostingRow,
} from "../../core/migration/domain.js";
import type { NewLine } from "../../core/ledger/ledger.repo.js";

const text = (name: string, label: string, o: Partial<FieldSpec> = {}): FieldSpec => ({
  name,
  label,
  type: "text",
  ...o,
});
const date = (name: string, label: string, o: Partial<FieldSpec> = {}): FieldSpec => ({
  name,
  label,
  type: "date",
  ...o,
});
const money = (name: string, label: string, o: Partial<FieldSpec> = {}): FieldSpec => ({
  name,
  label,
  type: "money",
  ...o,
});
const ref = (name: string, label: string, target: string, o: Partial<FieldSpec> = {}): FieldSpec => ({
  name,
  label,
  type: "ref",
  ref: target,
  ...o,
});
const oneOf = (name: string, label: string, values: readonly string[], o: Partial<FieldSpec> = {}): FieldSpec => ({
  name,
  label,
  type: "enum",
  values,
  ...o,
});
const int = (name: string, label: string, o: Partial<FieldSpec> = {}): FieldSpec => ({
  name,
  label,
  type: "int",
  ...o,
});
const contactFields = [
  text("name", "Name", { required: true, aliases: ["full name", "buyer name", "client name", "customer name"] }),
  { name: "email", label: "Email", type: "email", aliases: ["email address", "e mail"] } as FieldSpec,
  { name: "phone", label: "Phone", type: "phone", aliases: ["mobile", "telephone", "phone number"] } as FieldSpec,
  text("national_id", "National ID / passport / company number", { aliases: ["id number", "passport", "id no"] }),
];

export const DEVELOPMENT_ENTITIES: EntitySpec[] = [
  {
    name: "project",
    label: "Project",
    table: "dev_projects",
    labelField: "name",
    hints: ["projects", "developments", "schemes"],
    fields: [
      text("name", "Project name", { required: true, aliases: ["project name", "development"] }),
      text("code", "Project code"),
      text("location", "Location", { aliases: ["address", "site"] }),
      oneOf("status", "Status", ["planning", "construction", "selling", "completed"]),
      date("start_date", "Start date", { aliases: ["start"] }),
      date("end_date", "Expected completion", { aliases: ["completion date", "end"] }),
    ],
  },
  {
    name: "phase",
    label: "Phase",
    table: "dev_phases",
    labelField: "name",
    hints: ["phases", "stages"],
    fields: [
      ref("project_ref", "Project", "project", { required: true }),
      text("name", "Phase name", { required: true, aliases: ["phase name", "phase"] }),
      date("start_date", "Start date"),
      date("end_date", "End date"),
    ],
  },
  {
    name: "building",
    label: "Building / block",
    table: "dev_buildings",
    labelField: "name",
    hints: ["buildings", "blocks", "towers"],
    fields: [
      ref("project_ref", "Project", "project", { required: true }),
      ref("phase_ref", "Phase", "phase"),
      text("name", "Building name", { required: true, aliases: ["block", "block name", "building name", "tower"] }),
      int("floors_count", "Number of floors", { min: 0, max: 300, aliases: ["floors", "storeys"] }),
    ],
  },
  {
    name: "floor",
    label: "Floor",
    table: "dev_floors",
    labelField: "name",
    hints: ["floors", "levels"],
    fields: [
      ref("building_ref", "Building", "building", { required: true, aliases: ["block"] }),
      int("level", "Level", { required: true, min: -10, max: 300, aliases: ["floor", "floor number", "level no"] }),
      text("name", "Floor name"),
    ],
  },
  {
    name: "unit",
    label: "Unit",
    table: "dev_units",
    labelField: "unit_no",
    hints: ["units", "inventory", "apartments", "plots", "stock"],
    fields: [
      ref("project_ref", "Project", "project", { required: true }),
      ref("building_ref", "Building", "building", { aliases: ["block"] }),
      ref("floor_ref", "Floor", "floor"),
      text("unit_no", "Unit number", { required: true, aliases: ["unit", "unit number", "house no", "plot no"] }),
      text("type", "Type", { aliases: ["unit type", "typology"] }),
      int("bedrooms", "Bedrooms", { min: 0, max: 50, aliases: ["beds"] }),
      { name: "area_sqm", label: "Area (m²)", type: "decimal", min: 0, aliases: ["area", "size", "sqm"] },
      money("list_price", "List price", { aliases: ["price", "asking price"] }),
      oneOf("status", "Status", ["available", "reserved", "sold", "handed_over", "blocked"]),
    ],
  },
  {
    name: "buyer",
    label: "Buyer",
    table: "dev_contacts",
    fixed: { kind: "buyer" },
    labelField: "name",
    hints: ["buyers", "customers", "clients", "purchasers"],
    duplicateKeys: [["email"], ["phone"], ["national_id"]],
    fields: [
      ...contactFields,
      oneOf("party_type", "Individual or company", ["individual", "company"], { aliases: ["type"] }),
      text("address", "Address"),
    ],
  },
  {
    name: "investor",
    label: "Investor",
    table: "dev_contacts",
    fixed: { kind: "investor" },
    labelField: "name",
    hints: ["investors", "financiers", "shareholders"],
    duplicateKeys: [["email"], ["national_id"]],
    fields: [
      ...contactFields,
      oneOf("party_type", "Individual or company", ["individual", "company"]),
      ref("project_ref", "Project invested in", "project"),
      money("committed", "Committed amount", { aliases: ["commitment", "amount committed", "investment"] }),
    ],
  },
  {
    name: "reservation",
    label: "Reservation",
    table: "dev_reservations",
    labelField: "date",
    hints: ["reservations", "bookings", "holds"],
    fields: [
      ref("unit_ref", "Unit", "unit", { required: true }),
      ref("buyer_ref", "Buyer", "buyer", { required: true }),
      date("date", "Reservation date", { required: true, aliases: ["reserved on", "reservation date"] }),
      money("deposit", "Reservation deposit", { aliases: ["booking fee", "deposit paid"] }),
      date("expiry_date", "Expires", { aliases: ["expiry"] }),
      oneOf("status", "Status", ["active", "converted", "cancelled", "expired"]),
    ],
  },
  {
    name: "contract",
    label: "Sales contract",
    table: "dev_contracts",
    labelField: "number",
    hints: ["contracts", "sales", "sale agreements", "spa"],
    fields: [
      ref("unit_ref", "Unit", "unit", { required: true }),
      ref("buyer_ref", "Buyer", "buyer", { required: true }),
      ref("reservation_ref", "Reservation", "reservation"),
      text("number", "Contract number", { aliases: ["contract no", "agreement no"] }),
      date("date", "Contract date", { required: true, aliases: ["signed on", "contract date"] }),
      money("price", "Contract price", { required: true, min: 1, aliases: ["sale price", "contract value", "price"] }),
      money("reported_balance", "Balance in the source system", {
        signed: true,
        aliases: ["balance", "outstanding", "balance due"],
      }),
      oneOf("status", "Status", ["active", "completed", "cancelled"]),
    ],
  },
  {
    name: "amendment",
    label: "Contract amendment",
    table: "dev_contract_amendments",
    labelField: "description",
    hints: ["amendments", "variations", "addenda"],
    fields: [
      ref("contract_ref", "Contract", "contract", { required: true }),
      date("date", "Date", { required: true }),
      text("description", "What changed", { required: true }),
      money("price_change", "Price change (+/−)", { signed: true, aliases: ["price adjustment", "change in price"] }),
    ],
  },
  {
    name: "instalment",
    label: "Instalment",
    table: "dev_instalments",
    labelField: "due_date",
    hints: ["instalments", "installments", "payment plan", "schedule"],
    fields: [
      ref("contract_ref", "Contract", "contract", { required: true }),
      int("seq", "Instalment number", { required: true, min: 0, max: 1000, aliases: ["no", "instalment no"] }),
      date("due_date", "Due date", { required: true, aliases: ["due"] }),
      money("amount", "Amount", { required: true, min: 1, aliases: ["instalment amount", "amount due"] }),
      text("description", "Description", { aliases: ["milestone"] }),
    ],
  },
  {
    name: "payment",
    label: "Payment (receipt or refund)",
    table: "dev_payments",
    labelField: "reference",
    hints: ["payments", "receipts", "refunds", "collections"],
    fields: [
      ref("contract_ref", "Contract", "contract", { required: true }),
      ref("buyer_ref", "Buyer", "buyer"),
      oneOf("kind", "Receipt or refund", ["receipt", "refund"], { defaultValue: "receipt", aliases: ["type"] }),
      date("date", "Date", { required: true, aliases: ["payment date", "received on"] }),
      money("amount", "Amount", { required: true, min: 1, aliases: ["amount paid", "amount received"] }),
      text("method", "Method", { aliases: ["payment method", "mode"] }),
      text("reference", "Reference", { aliases: ["receipt no", "bank reference", "ref"] }),
    ],
  },
  {
    name: "allocation",
    label: "Payment allocation",
    table: "dev_payment_allocations",
    labelField: "amount",
    hints: ["allocations", "applied payments"],
    fields: [
      ref("payment_ref", "Payment", "payment", { required: true }),
      ref("instalment_ref", "Instalment", "instalment", { required: true }),
      money("amount", "Amount allocated", { required: true, min: 1, aliases: ["allocated", "applied"] }),
    ],
  },
  {
    name: "supplier",
    label: "Supplier",
    table: "dev_suppliers",
    fixed: { kind: "supplier" },
    labelField: "name",
    hints: ["suppliers", "vendors"],
    duplicateKeys: [["tax_id"], ["email"]],
    fields: [
      text("name", "Name", { required: true, aliases: ["supplier name", "vendor"] }),
      text("tax_id", "Tax PIN / VAT number", { aliases: ["tax id", "pin", "kra pin", "vat"] }),
      { name: "email", label: "Email", type: "email" },
      { name: "phone", label: "Phone", type: "phone" },
      text("trade", "Trade / category", { aliases: ["category"] }),
    ],
  },
  {
    name: "contractor",
    label: "Contractor",
    table: "dev_suppliers",
    fixed: { kind: "contractor" },
    labelField: "name",
    hints: ["contractors", "subcontractors"],
    duplicateKeys: [["tax_id"], ["email"]],
    fields: [
      text("name", "Name", { required: true, aliases: ["contractor name", "company"] }),
      text("tax_id", "Tax PIN / VAT number", { aliases: ["tax id", "pin", "kra pin"] }),
      { name: "email", label: "Email", type: "email" },
      { name: "phone", label: "Phone", type: "phone" },
      text("trade", "Trade", { aliases: ["specialty", "discipline"] }),
    ],
  },
  {
    name: "opening_balance",
    label: "Opening balance",
    table: "dev_opening_balances",
    labelField: "kind",
    hints: ["opening balances", "balances brought forward", "cut over balances"],
    fields: [
      oneOf("kind", "Kind", ["buyer_receivable", "buyer_deposit", "supplier_payable"], { required: true }),
      ref("contract_ref", "Contract", "contract"),
      ref("reservation_ref", "Reservation", "reservation"),
      ref("supplier_ref", "Supplier", "supplier"),
      date("as_of", "As of", { defaultsToCutover: true, aliases: ["date", "cut over date"] }),
      money("amount", "Amount", { required: true, min: 1, aliases: ["balance"] }),
      text("memo", "Memo", { aliases: ["note"] }),
    ],
  },
  {
    name: "purchase_order",
    label: "Purchase order",
    table: "dev_purchase_orders",
    labelField: "number",
    hints: ["purchase orders", "pos", "orders"],
    idAliases: ["po id", "po ref"],
    fields: [
      ref("supplier_ref", "Supplier", "supplier", { required: true, aliases: ["vendor"] }),
      ref("project_ref", "Project", "project", { required: true }),
      text("number", "PO number", { aliases: ["po number", "po no"] }),
      date("date", "Date", { required: true, aliases: ["po date"] }),
      money("amount", "Amount", { required: true, aliases: ["po amount", "total"] }),
      oneOf("status", "Status", ["open", "received", "closed", "cancelled"]),
      text("description", "Description"),
    ],
  },
  {
    name: "work_order",
    label: "Work order",
    table: "dev_work_orders",
    labelField: "number",
    hints: ["work orders"],
    idAliases: ["wo id", "job id"],
    fields: [
      ref("contractor_ref", "Contractor", "contractor", { required: true }),
      ref("project_ref", "Project", "project", { required: true }),
      ref("unit_ref", "Unit", "unit"),
      text("number", "Work order number", { aliases: ["wo no"] }),
      date("date", "Date", { required: true }),
      money("amount", "Amount", { aliases: ["value"] }),
      text("description", "Description", { required: true, aliases: ["scope"] }),
      oneOf("status", "Status", ["open", "in_progress", "done", "cancelled"]),
    ],
  },
  {
    name: "milestone",
    label: "Milestone",
    table: "dev_milestones",
    labelField: "name",
    hints: ["milestones", "programme", "progress"],
    fields: [
      ref("project_ref", "Project", "project", { required: true }),
      ref("phase_ref", "Phase", "phase"),
      text("name", "Milestone", { required: true, aliases: ["milestone"] }),
      date("due_date", "Due date", { aliases: ["planned date", "due"] }),
      date("completed_date", "Completed on", { aliases: ["actual date", "completed"] }),
      int("percent", "% complete", { min: 0, max: 100, aliases: ["percent complete", "progress"] }),
      oneOf("status", "Status", ["planned", "in_progress", "completed"]),
    ],
  },
  {
    name: "handover",
    label: "Handover",
    table: "dev_handovers",
    labelField: "date",
    hints: ["handovers", "handover", "completions"],
    fields: [
      ref("unit_ref", "Unit", "unit", { required: true }),
      ref("contract_ref", "Contract", "contract"),
      date("date", "Handover date", { required: true, aliases: ["handover date"] }),
      oneOf("status", "Status", ["scheduled", "completed"]),
      text("notes", "Notes"),
    ],
  },
  {
    name: "defect",
    label: "Defect",
    table: "dev_defects",
    labelField: "description",
    hints: ["defects", "snags", "snag list", "punch list"],
    fields: [
      ref("unit_ref", "Unit", "unit", { required: true }),
      ref("handover_ref", "Handover", "handover"),
      ref("contractor_ref", "Contractor responsible", "contractor"),
      date("reported_date", "Reported on", { required: true, aliases: ["reported", "date"] }),
      text("description", "Description", { required: true, aliases: ["defect", "issue"] }),
      oneOf("status", "Status", ["open", "fixed", "closed"]),
    ],
  },
  {
    name: "dispute",
    label: "Dispute",
    table: "dev_disputes",
    labelField: "subject",
    hints: ["disputes", "complaints", "claims"],
    fields: [
      ref("buyer_ref", "Buyer", "buyer", { required: true }),
      ref("contract_ref", "Contract", "contract"),
      date("opened_date", "Opened on", { required: true, aliases: ["opened", "date"] }),
      text("subject", "Subject", { required: true }),
      oneOf("status", "Status", ["open", "resolved", "closed"]),
      money("amount", "Amount in dispute", { aliases: ["amount"] }),
    ],
  },
  {
    name: "correspondence",
    label: "Correspondence",
    table: "dev_correspondence",
    labelField: "subject",
    hints: ["correspondence", "communications", "letters", "notes"],
    fields: [
      ref("buyer_ref", "Buyer", "buyer"),
      ref("contract_ref", "Contract", "contract"),
      ref("dispute_ref", "Dispute", "dispute"),
      date("date", "Date", { required: true }),
      oneOf("channel", "Channel", ["email", "letter", "call", "meeting", "sms", "whatsapp", "other"], {
        defaultValue: "other",
      }),
      text("subject", "Subject", { required: true }),
      text("summary", "Summary", { aliases: ["body", "content", "notes"] }),
    ],
  },
];

// ------------------------------------------------------------------ the domain's own checks
const num = (v: unknown) => (typeof v === "number" ? v : 0);
const issue = (row: CheckRow, code: string, message: string, field?: string): CheckIssue => ({
  rowId: row.rowId,
  severity: "error",
  code,
  message,
  ...(field ? { field } : {}),
});

/** Contracts, instalments, payments, allocations and opening balances must tell one consistent story. */
async function checks(c: CheckContext): Promise<CheckIssue[]> {
  const out: CheckIssue[] = [];
  const contracts = c.byEntity("contract").filter((r) => !r.inactive);
  const key = (ref: CheckRow["refs"][string] | undefined) =>
    ref ? ("rowId" in ref ? `r${ref.rowId}` : `t${ref.targetId}`) : "";
  const active = (e: string) => c.byEntity(e).filter((r) => !r.inactive);
  const group = (rows: CheckRow[], field: string) => {
    const m = new Map<string, CheckRow[]>();
    for (const r of rows) {
      const k = key(r.refs[field]);
      if (k) m.set(k, [...(m.get(k) ?? []), r]);
    }
    return m;
  };
  const instalmentsBy = group(active("instalment"), "contract_ref");
  const paymentsBy = group(active("payment"), "contract_ref");
  const amendmentsBy = group(active("amendment"), "contract_ref");
  const allocations = active("allocation");
  const allocByInstalment = group(allocations, "instalment_ref");
  const allocByPayment = group(allocations, "payment_ref");
  const receivableBy = group(
    active("opening_balance").filter((r) => r.values.kind === "buyer_receivable"),
    "contract_ref",
  );

  // a unit is sold once
  const unitContracts = group(
    contracts.filter((r) => r.values.status !== "cancelled"),
    "unit_ref",
  );
  for (const rows of unitContracts.values()) {
    if (rows.length > 1)
      for (const r of rows)
        out.push(
          issue(
            r,
            "UNIT_SOLD_TWICE",
            `The unit has ${rows.length} active contracts (${rows.map((x) => x.sourceId).join(", ")}) — cancel or skip all but one`,
            "unit_ref",
          ),
        );
  }

  for (const k of contracts) {
    const me = `r${k.rowId}`;
    const price =
      num(k.values.price) + (amendmentsBy.get(me) ?? []).reduce((s, a) => s + num(a.values.price_change), 0);
    const inst = instalmentsBy.get(me) ?? [];
    const scheduled = inst.reduce((s, i) => s + num(i.values.amount), 0);
    if (inst.length && scheduled !== price)
      out.push(
        issue(
          k,
          "SCHEDULE_NOT_EQUAL_PRICE",
          `Instalments total ${scheduled} but the contract price (with amendments) is ${price} (minor units)`,
          "price",
        ),
      );
    const pays = paymentsBy.get(me) ?? [];
    const paid = pays.reduce((s, p) => s + (p.values.kind === "refund" ? -1 : 1) * num(p.values.amount), 0);
    if (k.values.reported_balance !== null && k.values.reported_balance !== undefined) {
      const expected = price - paid;
      if (expected !== k.values.reported_balance)
        out.push(
          issue(
            k,
            "BALANCE_MISMATCH",
            `Outstanding should be price ${price} − net payments ${paid} = ${expected}, but the source says ${String(k.values.reported_balance)} (minor units)`,
            "reported_balance",
          ),
        );
    }
    if (paid > price)
      out.push(issue(k, "OVERPAID", `Net payments ${paid} exceed the contract price ${price} (minor units)`));
    // the receivable carried over = what fell due by the cut-over and was not paid
    const receivable = (receivableBy.get(me) ?? []).reduce((s, o) => s + num(o.values.amount), 0);
    if (receivableBy.has(me)) {
      const due = inst
        .filter((i) => String(i.values.due_date) <= c.cutoverDate)
        .reduce((s, i) => {
          const allocated = (allocByInstalment.get(`r${i.rowId}`) ?? []).reduce((a, x) => a + num(x.values.amount), 0);
          return s + Math.max(0, num(i.values.amount) - allocated);
        }, 0);
      if (due !== receivable)
        for (const o of receivableBy.get(me) ?? [])
          out.push(
            issue(
              o,
              "RECEIVABLE_MISMATCH",
              `The receivable carried over (${receivable}) does not equal the instalments due by ${c.cutoverDate} and unpaid (${due}) for contract ${k.sourceId}`,
              "amount",
            ),
          );
    }
  }

  // allocations: never more than the instalment or the payment, and on the same contract
  for (const a of allocations) {
    const p = c.rowOf(a.refs.payment_ref);
    const i = c.rowOf(a.refs.instalment_ref);
    if (p && p.values.kind === "refund")
      out.push(issue(a, "REFUND_ALLOCATED", "A refund cannot be allocated", "payment_ref"));
    if (p && i && key(p.refs.contract_ref) !== key(i.refs.contract_ref))
      out.push(
        issue(
          a,
          "ALLOCATION_CONTRACT_MISMATCH",
          `Payment ${p.sourceId} and instalment ${i.sourceId} belong to different contracts`,
        ),
      );
  }
  for (const [k, rows] of allocByInstalment) {
    const i = c.rowOf(rows[0]?.refs.instalment_ref);
    const total = rows.reduce((s, r) => s + num(r.values.amount), 0);
    if (i && total > num(i.values.amount))
      for (const r of rows)
        out.push(
          issue(
            r,
            "OVER_ALLOCATED",
            `Allocations to instalment ${i.sourceId} total ${total}, more than its amount ${num(i.values.amount)}`,
            "amount",
          ),
        );
    void k;
  }
  for (const rows of allocByPayment.values()) {
    const p = c.rowOf(rows[0]?.refs.payment_ref);
    const total = rows.reduce((s, r) => s + num(r.values.amount), 0);
    if (p && total > num(p.values.amount))
      for (const r of rows)
        out.push(
          issue(
            r,
            "PAYMENT_OVER_ALLOCATED",
            `Allocations of payment ${p.sourceId} total ${total}, more than the payment ${num(p.values.amount)}`,
            "amount",
          ),
        );
  }

  // a payment's buyer is the contract's buyer
  for (const p of active("payment")) {
    const k = c.rowOf(p.refs.contract_ref);
    if (k && p.refs.buyer_ref && key(p.refs.buyer_ref) !== key(k.refs.buyer_ref))
      out.push(
        issue(p, "BUYER_MISMATCH", `The payment's buyer is not the buyer on contract ${k.sourceId}`, "buyer_ref"),
      );
  }
  // a unit's building is in the unit's project; a contract follows its reservation
  for (const u of active("unit")) {
    const b = c.rowOf(u.refs.building_ref);
    if (b && key(b.refs.project_ref) !== key(u.refs.project_ref))
      out.push(issue(u, "BUILDING_PROJECT_MISMATCH", `Building ${b.sourceId} is in another project`, "building_ref"));
  }
  for (const k of contracts) {
    const r = c.rowOf(k.refs.reservation_ref);
    if (r && (key(r.refs.unit_ref) !== key(k.refs.unit_ref) || key(r.refs.buyer_ref) !== key(k.refs.buyer_ref)))
      out.push(
        issue(k, "RESERVATION_MISMATCH", `Reservation ${r.sourceId} is for another unit or buyer`, "reservation_ref"),
      );
  }
  // opening balances: the right link for their kind, dated at the cut-over, deposits within what was paid
  for (const o of active("opening_balance")) {
    const need = {
      buyer_receivable: "contract_ref",
      buyer_deposit: "reservation_ref",
      supplier_payable: "supplier_ref",
    }[String(o.values.kind) as "buyer_receivable"];
    if (need && !o.refs[need])
      out.push(
        issue(
          o,
          "OPENING_BALANCE_LINK",
          `A ${String(o.values.kind)} opening balance needs a ${need.replace("_ref", "")}`,
          need,
        ),
      );
    if (o.values.as_of && o.values.as_of !== c.cutoverDate)
      out.push(
        issue(o, "OPENING_BALANCE_DATE", `Opening balances are as of the cut-over date ${c.cutoverDate}`, "as_of"),
      );
    if (o.values.kind === "buyer_deposit") {
      const r = c.rowOf(o.refs.reservation_ref);
      if (r && num(o.values.amount) > num(r.values.deposit))
        out.push(
          issue(
            o,
            "DEPOSIT_EXCEEDS_PAID",
            `The deposit held (${num(o.values.amount)}) is more than reservation ${r.sourceId} records (${num(r.values.deposit)})`,
            "amount",
          ),
        );
    }
  }
  return out;
}

function posting(entity: string, rows: PostingRow[], cutoverDate: string): { memo: string; lines: NewLine[] } | null {
  if (entity !== "opening_balance" || !rows.length) return null;
  const sum = (kind: string) =>
    rows.filter((r) => r.values.kind === kind).reduce((s, r) => s + num(r.values.amount), 0);
  const receivable = sum("buyer_receivable");
  const deposits = sum("buyer_deposit");
  const payables = sum("supplier_payable");
  const net = receivable - deposits - payables;
  const lines: NewLine[] = [];
  if (receivable)
    lines.push({ account: "1170", debitMinor: receivable, creditMinor: 0, memo: "Buyer receivables brought forward" });
  if (deposits)
    lines.push({ account: "2400", debitMinor: 0, creditMinor: deposits, memo: "Buyer deposits held brought forward" });
  if (payables)
    lines.push({ account: "2000", debitMinor: 0, creditMinor: payables, memo: "Supplier balances brought forward" });
  if (net > 0) lines.push({ account: "3900", debitMinor: 0, creditMinor: net, memo: "Opening balance equity" });
  if (net < 0) lines.push({ account: "3900", debitMinor: -net, creditMinor: 0, memo: "Opening balance equity" });
  return { memo: `Opening balances at ${cutoverDate} brought over from the previous system`, lines };
}

export const developmentMigration: MigrationDomain = {
  key: "development",
  label: "Real Estate Development",
  product: "developer",
  entities: DEVELOPMENT_ENTITIES,
  documentTargets: ["contract", "unit", "buyer", "reservation", "handover", "defect", "dispute", "purchase_order"],
  documentTable: "dev_documents",
  accounts: [
    {
      code: "1170",
      name: "Buyer receivables",
      type: "asset",
      system: true,
      use: "Instalments due and unpaid at the cut-over",
    },
    {
      code: "2400",
      name: "Buyer deposits held",
      type: "liability",
      system: true,
      use: "Reservation deposits held at the cut-over",
    },
    {
      code: "3900",
      name: "Opening balance equity",
      type: "equity",
      system: true,
      use: "The other side of every opening balance",
    },
  ],
  allowanceEntity: "project",
  checks,
  posting,
};
