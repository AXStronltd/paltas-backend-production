/*
 * Property Management as a data-migration target (the workspace's "Accounting data migration" screen): an agency moves
 * its books from accounting software (e.g. a QuickBooks export) into PALTAS at a cut-over date.
 *
 *   account list → (properties → units) → owners → tenants (customers) → suppliers (vendors) → leases (recurring rent
 *   templates) → open invoices → tenant deposits → unpaid bills → trial balance;  documents linked to records.
 *
 * Tenants, owners and suppliers go into the ONE contact store (core contacts), deduplicated by email and phone against
 * the upload and against contacts already in PALTAS. Leases name their unit by number: the building and its units are
 * set up in PALTAS first (or come in the same upload). Opening balances post to the ONE ledger at the cut-over, one
 * journal per import batch, exactly as the workspace's posting rules say:
 *
 *   open invoice        Dr 1120 Tenant receivables          Cr 3900 Opening balance equity (already income there)
 *   tenant deposit      Dr 3900                             Cr 2300 Tenant deposits held
 *   unpaid bill         Dr 3900                             Cr 2000 Accounts payable
 *   trial balance       bank Dr 1040 · owner funds Cr 2250 (per owner) · balanced by 3900
 *
 * The trial balance must agree with the detail: receivables = open invoices, deposits = deposits by tenant, payables =
 * unpaid bills, and debits = credits — so the migration clearing account 3900 ends at zero.
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
import { ACC, PM_ACCOUNTS } from "./accounts.js";

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
const contact = (role: "tenant" | "owner" | "supplier"): FieldSpec[] => [
  text("name", "Name", {
    required: true,
    aliases: ["full name", "display name", "customer name", "vendor name", `${role} name`],
  }),
  { name: "email", label: "Email", type: "email", aliases: ["email address", "e mail"] },
  { name: "phone", label: "Phone", type: "phone", aliases: ["phone numbers", "mobile", "telephone", "phone number"] },
  text("address", "Address", { aliases: ["billing address", "postal address"] }),
  // the role the contact is imported as (added to the contact's types)
  oneOf("imported_as", "Imported as", [role], { defaultValue: role }),
];

/** The PALTAS accounts a trial-balance line can belong to (or skip: history stays in the source system). */
export const TB_ACCOUNTS = [
  ACC.clientBank,
  ACC.receivables,
  ACC.depositsHeld,
  ACC.ownerFunds,
  ACC.payables,
  "skip",
] as const;

export const PROPERTY_ENTITIES: EntitySpec[] = [
  {
    name: "account",
    label: "Source account",
    table: "pm_source_accounts",
    labelField: "name",
    hints: ["account list", "chart of accounts", "accounts"],
    idAliases: ["account"],
    fields: [
      text("name", "Account name", { required: true, aliases: ["account name"] }),
      text("type", "Type", { aliases: ["account type"] }),
      text("detail_type", "Detail type", { aliases: ["detail type"] }),
      text("description", "Description"),
      money("balance", "Balance", { signed: true }),
    ],
  },
  {
    name: "property",
    label: "Property",
    table: "pm_properties",
    labelField: "name",
    hints: ["properties", "buildings", "estates"],
    fields: [
      text("name", "Property name", { required: true, aliases: ["property", "building", "property name"] }),
      text("address", "Address", { aliases: ["location", "area"], defaultValue: "" }),
    ],
  },
  {
    name: "unit",
    label: "Unit",
    table: "pm_units",
    labelField: "unit_no",
    hints: ["units", "unit list", "apartments"],
    fields: [
      ref("property_ref", "Property", "property", { required: true }),
      text("unit_no", "Unit number", { required: true, aliases: ["unit", "unit no", "house no", "door"] }),
      text("floor", "Floor"),
      text("unit_type", "Type", { aliases: ["unit type"] }),
      { name: "bedrooms", label: "Bedrooms", type: "int", min: 0, max: 50, aliases: ["beds"] },
      money("market_rent", "Market rent", { aliases: ["rent", "asking rent"] }),
    ],
  },
  {
    name: "owner",
    label: "Owner",
    table: "contacts",
    labelField: "name",
    hints: ["owners", "landlords"],
    duplicateKeys: [["email"], ["phone"]],
    fields: [...contact("owner"), text("tax_id", "Tax PIN", { aliases: ["tax id", "kra pin", "pin"] })],
  },
  {
    name: "tenant",
    label: "Tenant (customer)",
    table: "contacts",
    labelField: "name",
    hints: ["customer contact list", "customers", "tenants"],
    idAliases: ["customer"],
    duplicateKeys: [["email"], ["phone"]],
    fields: contact("tenant"),
  },
  {
    name: "vendor",
    label: "Supplier (vendor)",
    table: "contacts",
    labelField: "name",
    hints: ["vendor contact list", "vendors", "suppliers"],
    idAliases: ["vendor"],
    duplicateKeys: [["tax_id"], ["email"]],
    fields: [
      ...contact("supplier"),
      text("tax_id", "Tax PIN / VAT number", { aliases: ["tax id", "kra pin", "pin", "vat"] }),
    ],
  },
  {
    name: "lease",
    label: "Lease (recurring rent)",
    table: "pm_leases",
    labelField: "migrated_unit_no",
    hints: ["recurring template list", "recurring", "leases", "rent roll"],
    idAliases: ["template name", "lease id"],
    fields: [
      ref("tenant_ref", "Tenant", "tenant", { required: true, aliases: ["customer"] }),
      ref("upload_unit_ref", "Unit (in this upload)", "unit"),
      text("migrated_unit_no", "Unit number (set up in PALTAS)", { aliases: ["unit", "unit no", "unit number"] }),
      date("start_date", "Lease start", { defaultsToCutover: true, aliases: ["start", "start date"] }),
      date("end_date", "Lease end (empty = periodic)", { aliases: ["end", "end date"] }),
      money("rent", "Monthly rent", { required: true, min: 1, aliases: ["amount", "rent amount"] }),
      {
        name: "due_day",
        label: "Due day",
        type: "int",
        min: 1,
        max: 28,
        defaultValue: "5",
        aliases: ["day", "interval"],
      },
      oneOf("status", "Status", ["active"], { defaultValue: "active" }),
      oneOf("deposit_mode", "Deposit", ["held"], { defaultValue: "held" }),
    ],
  },
  {
    name: "opening_invoice",
    label: "Open invoice",
    table: "pm_invoices",
    fixed: { kind: "opening" },
    labelField: "number",
    hints: ["open invoices", "unpaid invoices", "invoices"],
    idAliases: ["num", "invoice no", "invoice number"],
    fields: [
      ref("tenant_ref", "Tenant", "tenant", { required: true, aliases: ["customer"] }),
      date("issue_date", "Invoice date", { required: true, aliases: ["date", "invoice date"] }),
      date("due_date", "Due date", { required: true, aliases: ["due date"] }),
      money("amount", "Open balance", { required: true, min: 1, aliases: ["open balance", "balance"] }),
      money("original_amount", "Original amount", { aliases: ["amount", "total"] }),
      text("note", "Memo", { defaultValue: "Brought forward from the previous system" }),
    ],
  },
  {
    name: "deposit",
    label: "Tenant deposit held",
    table: "pm_opening_deposits",
    labelField: "amount_minor",
    hints: ["security deposits", "deposits quickreport", "deposits"],
    fields: [
      ref("tenant_ref", "Tenant", "tenant", { required: true, aliases: ["customer"] }),
      money("amount", "Deposit held", { required: true, min: 1 }),
      date("as_of", "As of", { defaultsToCutover: true }),
    ],
  },
  {
    name: "bill",
    label: "Unpaid bill",
    table: "pm_bills",
    labelField: "supplier_invoice_no",
    hints: ["unpaid bills", "bills", "payables"],
    idAliases: ["num", "bill no"],
    fields: [
      ref("supplier_ref", "Supplier", "vendor", { required: true, aliases: ["vendor"] }),
      text("supplier_invoice_no", "Supplier invoice number", { aliases: ["ref no", "invoice no"] }),
      date("bill_date", "Bill date", { required: true, aliases: ["date"] }),
      date("due_date", "Due date", { aliases: ["due date"] }),
      money("amount", "Open balance", { required: true, min: 1, aliases: ["open balance", "balance"] }),
      text("description", "Memo", { aliases: ["memo"], defaultValue: "Brought forward from the previous system" }),
      oneOf("status", "Status", ["approved"], { defaultValue: "approved" }),
    ],
  },
  {
    name: "trial_balance",
    label: "Trial balance line",
    table: "pm_trial_balance_lines",
    labelField: "account",
    hints: ["trial balance"],
    fields: [
      text("account", "Account", { required: true }),
      money("debit", "Debit"),
      money("credit", "Credit"),
      oneOf("paltas_account", "PALTAS account", TB_ACCOUNTS, { required: true }),
      ref("owner_ref", "Owner (for owner funds)", "owner"),
      date("as_of", "As of", { defaultsToCutover: true }),
    ],
  },
  {
    name: "historical_summary",
    label: "Historical monthly summary (reference only — no posting)",
    table: "pm_historical_records",
    labelField: "source_subject",
    hints: ["historical monthly summary"],
    duplicateKeys: [["property_id", "unit_label", "record_kind", "period"]],
    fields: [
      text("property_id", "PALTAS property ID", { required: true }),
      text("unit_label", "Unit identifier"),
      oneOf(
        "record_kind",
        "Meaning of monthly amount",
        ["service_charge_summary", "rent_summary", "payment_summary", "balance_summary", "expense_summary"],
        { required: true },
      ),
      text("period", "Original accounting period (YYYY-MM)", { required: true }),
      text("source_subject", "Name in source workbook", { required: true }),
      oneOf("subject_type", "Source name identifies", ["tenant", "owner"], { required: true }),
      money("amount", "Original monthly amount", { required: true, signed: true }),
      text("currency", "Original currency", { required: true }),
      text("source_workbook", "Source workbook", { required: true }),
      text("source_worksheet", "Source worksheet", { required: true }),
      text("source_cell", "Original Excel cell", { required: true }),
    ],
  },
];

// ------------------------------------------------------------------ the domain's own checks
const num = (v: unknown) => (typeof v === "number" ? v : 0);
const issue = (row: CheckRow | null, code: string, message: string, field?: string): CheckIssue => ({
  rowId: row?.rowId ?? null,
  severity: "error",
  code,
  message,
  ...(field ? { field } : {}),
});
const warn = (row: CheckRow | null, code: string, message: string, field?: string): CheckIssue => ({
  ...issue(row, code, message, field),
  severity: "warning",
});
const tbBalance = (r: CheckRow) => num(r.values.debit) - num(r.values.credit);

async function checks(c: CheckContext): Promise<CheckIssue[]> {
  const out: CheckIssue[] = [];
  const live = (e: string) => c.byEntity(e).filter((r) => !r.inactive);

  const historyRows = live("historical_summary"),
    historyKeys = new Map<string, CheckRow>();
  const propertyIds = [...new Set(historyRows.map((r) => String(r.values.property_id ?? "")))];
  const properties = new Set(
    (propertyIds.length
      ? await c.db.rows<{ id: string }>("SELECT id FROM pm_properties WHERE org_id=$1 AND id=ANY($2)", [
          c.orgId,
          propertyIds,
        ])
      : []
    ).map((p) => p.id),
  );
  const canonical = (s: string) => s.toUpperCase().replace(/\s/g, "").replace(/^0+/, "");
  const savedUnits = propertyIds.length
    ? await c.db.rows<{ id: string; property_id: string; unit_no: string; archived: boolean }>(
        "SELECT u.id,u.property_id,u.unit_no,COALESCE(b.is_archived,false) AS archived FROM pm_units u LEFT JOIN pm_buildings b ON b.id=u.building_id AND b.org_id=u.org_id WHERE u.org_id=$1 AND u.property_id=ANY($2)",
        [c.orgId, propertyIds],
      )
    : [];
  const unitIndex = new Map<string, typeof savedUnits>();
  for (const u of savedUnits) {
    const key = JSON.stringify([u.property_id, canonical(u.unit_no)]);
    unitIndex.set(key, [...(unitIndex.get(key) ?? []), u]);
  }
  const existing = propertyIds.length
    ? await c.db.rows<{ property_id: string; unit_id: string; record_kind: string; period: string }>(
        "SELECT property_id,unit_id,record_kind,period FROM pm_historical_records WHERE org_id=$1 AND property_id=ANY($2) AND period=ANY($3) AND record_kind=ANY($4)",
        [
          c.orgId,
          propertyIds,
          [...new Set(historyRows.map((r) => String(r.values.period ?? "")))],
          [...new Set(historyRows.map((r) => String(r.values.record_kind ?? "")))],
        ],
      )
    : [];
  const existingKeys = new Set(
    existing.map((r) => JSON.stringify([r.property_id, r.unit_id, r.record_kind, r.period])),
  );
  // Resolve a whole report with bounded queries, including retired units for non-posting historical reference.
  for (const r of historyRows) {
    if (!properties.has(String(r.values.property_id ?? ""))) {
      out.push(issue(r, "HISTORY_PROPERTY", "Choose a saved property in this organisation", "property_id"));
      continue;
    }
    const period = String(r.values.period ?? "");
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period))
      out.push(issue(r, "HISTORY_PERIOD", "Use the original monthly accounting period, for example 2021-04", "period"));
    if (String(r.values.currency ?? "").toUpperCase() !== c.currency)
      out.push(
        issue(
          r,
          "HISTORY_CURRENCY",
          "The original currency must match this workspace; historical amounts are never converted automatically",
          "currency",
        ),
      );
    const label = String(r.values.unit_label ?? "").trim(),
      hits = unitIndex.get(JSON.stringify([r.values.property_id, canonical(label)])) ?? [];
    if (label && hits.length === 1) {
      const u = hits[0];
      if (!u) continue;
      const key = JSON.stringify([r.values.property_id, u.id, r.values.record_kind, period]),
        duplicate = historyKeys.get(key);
      if (duplicate) {
        out.push(
          issue(
            r,
            "HISTORY_DUPLICATE",
            "This saved apartment already has another summary for the same month and meaning in this import",
            "unit_label",
          ),
        );
        out.push(
          issue(
            duplicate,
            "HISTORY_DUPLICATE",
            "Another row duplicates this apartment, month and summary meaning",
            "unit_label",
          ),
        );
      } else historyKeys.set(key, r);
      if (existingKeys.has(key))
        out.push(
          issue(
            r,
            "HISTORY_DUPLICATE_EXISTING",
            "A summary for this saved apartment, month and meaning is already imported. Review its source reference instead of creating another",
            "unit_label",
          ),
        );
      if (u.archived)
        out.push(
          warn(
            r,
            "HISTORY_RETIRED_UNIT",
            "This apartment is archived. Its historical reference will be retained without restoring it to current inventory",
            "unit_label",
          ),
        );
    } else if (label || r.values.record_kind !== "expense_summary")
      out.push(
        issue(
          r,
          "HISTORY_UNIT",
          label
            ? `Unit ${label} must match exactly one saved apartment in this property. Correct the identifier; names are not assumed to be units`
            : "Map the apartment identifier for this monthly record",
          "unit_label",
        ),
      );
    if (r.values.record_kind !== "balance_summary" && num(r.values.amount) < 0)
      out.push(
        issue(
          r,
          "HISTORY_AMOUNT",
          "Negative charges or payments need a separately identified adjustment; do not silently treat them as ordinary monthly totals",
          "amount",
        ),
      );
  }

  // leases: a unit (in the upload, or set up in PALTAS by number), active at the cut-over, one per unit
  const units = new Map<string, CheckRow[]>();
  for (const l of live("lease")) {
    const no = typeof l.values.migrated_unit_no === "string" ? l.values.migrated_unit_no.trim() : "";
    if (!l.refs.upload_unit_ref && !no) {
      out.push(
        issue(
          l,
          "LEASE_UNIT",
          "Give the lease's unit (its number in PALTAS, or a unit in this upload)",
          "migrated_unit_no",
        ),
      );
      continue;
    }
    let key = l.refs.upload_unit_ref ? JSON.stringify(l.refs.upload_unit_ref) : "";
    if (!l.refs.upload_unit_ref) {
      const hits = await c.db.rows<{ id: string }>(
        "SELECT id FROM pm_units WHERE org_id = $1 AND upper(unit_no) = upper($2)",
        [c.orgId, no],
      );
      if (hits.length !== 1) {
        out.push(
          issue(
            l,
            hits.length ? "UNIT_AMBIGUOUS" : "UNIT_NOT_SET_UP",
            hits.length
              ? `Unit ${no} exists in more than one property — give the unit from this upload instead`
              : `Unit ${no} is not set up in PALTAS — set up the building and its units first`,
            "migrated_unit_no",
          ),
        );
        continue;
      }
      key = (hits[0] as { id: string }).id;
      const busy = await c.db.row<{ number: string }>(
        "SELECT number FROM pm_leases WHERE unit_id = $1 AND status = 'active' AND (end_date IS NULL OR end_date >= $2)",
        [key, c.cutoverDate],
      );
      if (busy)
        out.push(
          issue(
            l,
            "UNIT_ALREADY_LET",
            `Unit ${no} already has active lease ${busy.number} in PALTAS`,
            "migrated_unit_no",
          ),
        );
    }
    units.set(key, [...(units.get(key) ?? []), l]);
    const end = l.values.end_date;
    if (typeof end === "string" && end < c.cutoverDate)
      out.push(
        issue(
          l,
          "LEASE_ENDED",
          `The lease ended on ${end}, before the cut-over ${c.cutoverDate}, but rent continues — clear the end date to import it as periodic (month to month), or skip it`,
          "end_date",
        ),
      );
    if (typeof l.values.start_date === "string" && l.values.start_date > c.cutoverDate)
      out.push(
        issue(
          l,
          "LEASE_NOT_STARTED",
          "The lease starts after the cut-over — add it in PALTAS when it starts",
          "start_date",
        ),
      );
  }
  for (const rows of units.values())
    if (rows.length > 1)
      for (const r of rows)
        out.push(
          issue(
            r,
            "UNIT_LET_TWICE",
            `${rows.length} leases in the upload are for the same unit — keep one`,
            "migrated_unit_no",
          ),
        );

  // the trial balance agrees with the detail, and balances
  const tb = live("trial_balance");
  if (tb.length) {
    for (const r of tb) {
      if (/^\s*total\s*$/i.test(String(r.values.account ?? "")))
        out.push(issue(r, "TB_TOTAL_LINE", "This is the export's total line, not an account — skip it", "account"));
      const bal = tbBalance(r);
      if (r.values.paltas_account === "skip" && bal !== 0)
        out.push(
          issue(
            r,
            "TB_SKIPPED_BALANCE",
            `"${String(r.values.account)}" has a balance of ${bal} but is set to not migrated`,
            "paltas_account",
          ),
        );
      if (r.values.paltas_account === ACC.ownerFunds && bal !== 0 && !r.refs.owner_ref)
        out.push(
          issue(
            r,
            "TB_OWNER_NEEDED",
            `Owner funds "${String(r.values.account)}": choose the owner they belong to`,
            "owner_ref",
          ),
        );
    }
    const real = tb.filter((r) => !/^\s*total\s*$/i.test(String(r.values.account ?? "")));
    const dr = real.reduce((s, r) => s + num(r.values.debit), 0);
    const cr = real.reduce((s, r) => s + num(r.values.credit), 0);
    if (dr !== cr)
      out.push(
        issue(null, "TB_NOT_BALANCED", `The trial balance does not balance: debits ${dr}, credits ${cr} (minor units)`),
      );
    const of = (code: string) =>
      real.filter((r) => r.values.paltas_account === code).reduce((s, r) => s + tbBalance(r), 0);
    const pairs: [string, string, number, number][] = [
      [
        ACC.receivables,
        "open invoices",
        of(ACC.receivables),
        live("opening_invoice").reduce((s, r) => s + num(r.values.amount), 0),
      ],
      [
        ACC.depositsHeld,
        "deposits by tenant",
        -of(ACC.depositsHeld),
        live("deposit").reduce((s, r) => s + num(r.values.amount), 0),
      ],
      [ACC.payables, "unpaid bills", -of(ACC.payables), live("bill").reduce((s, r) => s + num(r.values.amount), 0)],
    ];
    for (const [code, what, fromTb, detail] of pairs)
      if (fromTb !== detail)
        out.push(
          issue(
            null,
            "TB_DETAIL_MISMATCH",
            `The trial balance says ${fromTb} for ${code}, but the ${what} add up to ${detail} (minor units)`,
          ),
        );
    const accounts = new Set(live("account").map((a) => String(a.values.name ?? "").toLowerCase()));
    if (accounts.size)
      for (const r of real)
        if (!accounts.has(String(r.values.account ?? "").toLowerCase()))
          out.push(
            warn(r, "TB_ACCOUNT_UNKNOWN", `"${String(r.values.account)}" is not in the account list`, "account"),
          );
  }
  // the account list's balances agree with the trial balance
  for (const a of live("account")) {
    const t = tb.find(
      (r) => String(r.values.account ?? "").toLowerCase() === String(a.values.name ?? "").toLowerCase(),
    );
    if (t && a.values.balance !== null && a.values.balance !== undefined) {
      const tbAbs = Math.abs(tbBalance(t));
      if (Math.abs(num(a.values.balance)) !== tbAbs)
        out.push(
          issue(
            a,
            "ACCOUNT_BALANCE_MISMATCH",
            `The account list says ${num(a.values.balance)}, the trial balance ${tbAbs}`,
            "balance",
          ),
        );
    }
  }
  // deposits: one tenant once
  const depTenants = new Map<string, CheckRow[]>();
  for (const d of live("deposit")) {
    const k = JSON.stringify(d.refs.tenant_ref ?? null);
    depTenants.set(k, [...(depTenants.get(k) ?? []), d]);
  }
  for (const rows of depTenants.values())
    if (rows.length > 1)
      for (const r of rows)
        out.push(warn(r, "DEPOSIT_SPLIT", `${rows.length} deposit rows for one tenant — they are added up`));
  return out;
}

function posting(entity: string, rows: PostingRow[], cutoverDate: string): { memo: string; lines: NewLine[] } | null {
  if (!rows.length) return null;
  const total = (field: string) => rows.reduce((s, r) => s + num(r.values[field]), 0);
  const memo = `Opening balances at ${cutoverDate} brought over from the previous system`;
  const L = (account: string, debit: number, credit: number, m: string): NewLine => ({
    account,
    debitMinor: debit,
    creditMinor: credit,
    memo: m,
  });
  switch (entity) {
    case "opening_invoice": {
      const n = total("amount");
      return n
        ? {
            memo,
            lines: [
              L(ACC.receivables, n, 0, "Open invoices brought forward"),
              L(ACC.openingEquity, 0, n, "Opening balance equity"),
            ],
          }
        : null;
    }
    case "deposit": {
      const n = total("amount");
      return n
        ? {
            memo,
            lines: [
              L(ACC.openingEquity, n, 0, "Opening balance equity"),
              L(ACC.depositsHeld, 0, n, "Tenant deposits brought forward"),
            ],
          }
        : null;
    }
    case "bill": {
      const n = total("amount");
      return n
        ? {
            memo,
            lines: [
              L(ACC.openingEquity, n, 0, "Opening balance equity"),
              L(ACC.payables, 0, n, "Unpaid bills brought forward"),
            ],
          }
        : null;
    }
    case "trial_balance": {
      const bal = (code: string) =>
        rows
          .filter((r) => r.values.paltas_account === code)
          .reduce((s, r) => s + num(r.values.debit) - num(r.values.credit), 0);
      const bank = bal(ACC.clientBank);
      const owners = -bal(ACC.ownerFunds);
      const lines: NewLine[] = [];
      if (bank > 0) lines.push(L(ACC.clientBank, bank, 0, "Client account brought forward"));
      if (bank < 0) lines.push(L(ACC.clientBank, 0, -bank, "Client account brought forward (overdrawn)"));
      if (owners > 0) lines.push(L(ACC.ownerFunds, 0, owners, "Owner funds brought forward"));
      if (owners < 0) lines.push(L(ACC.ownerFunds, -owners, 0, "Owner funds brought forward (owed by owners)"));
      const net = bank - owners;
      if (net > 0) lines.push(L(ACC.openingEquity, 0, net, "Opening balance equity"));
      if (net < 0) lines.push(L(ACC.openingEquity, -net, 0, "Opening balance equity"));
      return lines.length >= 2 ? { memo, lines } : null;
    }
    default:
      return null;
  }
}

const USE: Record<string, string> = {
  [ACC.clientBank]: "Client (trust) bank balance at the cut-over",
  [ACC.receivables]: "Open tenant invoices at the cut-over",
  [ACC.ownerFunds]: "What the agency holds for each owner at the cut-over",
  [ACC.depositsHeld]: "Tenant deposits held at the cut-over",
  [ACC.openingEquity]: "The other side of every opening balance; nets to zero when the trial balance agrees",
};

export const propertyMigration: MigrationDomain = {
  key: "property",
  label: "Property Management (accounting data)",
  product: "property",
  entities: PROPERTY_ENTITIES,
  documentTargets: ["lease", "tenant", "owner", "unit", "property", "bill", "opening_invoice"],
  documentTable: "pm_documents",
  accounts: PM_ACCOUNTS.filter((a) => USE[a.code]).map((a) => ({ ...a, use: USE[a.code] as string })),
  allowanceEntity: "property",
  checks,
  posting,
};
