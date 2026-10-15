// The organisation's ONE double-entry ledger. Every product posts into it; there is no second ledger.
//
// Rules the database itself enforces (not only this API):
// - a posted journal balances (debits = credits) and can never be changed or deleted — mistakes are reversed;
// - nothing posts into a closed month;
// - a manual journal is approved by someone other than the person who prepared it.
import { z } from "zod";
import { Currency, IsoDate, IsoDateTime, IsoMonth, MinorUnits, Reason } from "../common.js";
import { endpoint } from "../endpoint.js";
import { OrgParams } from "./organisations.js";

export const ACCOUNT_TYPES = ["asset", "liability", "equity", "income", "expense"] as const;
export const AccountType = z.enum(ACCOUNT_TYPES);
export type AccountType = z.infer<typeof AccountType>;

export const AccountCode = z.string().regex(/^\d{4,6}$/, "Account codes are 4–6 digits");

export const LedgerAccount = z.object({
  code: AccountCode,
  name: z.string(),
  type: AccountType,
  /** System accounts are used by automatic postings; they can be renamed but not deactivated. */
  system: z.boolean(),
  active: z.boolean(),
  /** Debit-positive balance of posted journals up to today. */
  balanceMinor: MinorUnits,
});
export type LedgerAccount = z.infer<typeof LedgerAccount>;

export const JournalStatus = z.enum(["awaiting_approval", "posted", "rejected"]);
export type JournalStatus = z.infer<typeof JournalStatus>;

export const JournalLineInput = z
  .object({
    account: AccountCode,
    debitMinor: MinorUnits.min(0).default(0),
    creditMinor: MinorUnits.min(0).default(0),
    memo: z.string().trim().max(300).optional(),
  })
  .refine((l) => l.debitMinor > 0 !== l.creditMinor > 0, "Each line is either a debit or a credit, above zero");

export const JournalLine = z.object({
  lineNo: z.number().int(),
  account: AccountCode,
  accountName: z.string(),
  debitMinor: MinorUnits,
  creditMinor: MinorUnits,
  memo: z.string(),
});

export const Journal = z.object({
  id: z.string(),
  number: z.string(),
  date: IsoDate,
  memo: z.string(),
  currency: Currency,
  /** "manual", or "system:<module>" for postings made by a product workflow. */
  source: z.string(),
  sourceRef: z.string().nullable(),
  status: JournalStatus,
  preparedBy: z.string().nullable(),
  approvedBy: z.string().nullable(),
  approvedAt: IsoDateTime.nullable(),
  rejectedReason: z.string().nullable(),
  reverses: z.string().nullable(),
  reversedBy: z.string().nullable(),
  totalMinor: MinorUnits,
  lines: z.array(JournalLine),
});
export type Journal = z.infer<typeof Journal>;

const JournalParams = OrgParams.extend({ journalId: z.string().min(1) });

export const listAccounts = endpoint({
  id: "ledger.accounts.list",
  method: "GET",
  path: "/api/v1/orgs/:orgId/ledger/accounts",
  auth: "user",
  summary: "The chart of accounts with balances",
  params: OrgParams,
  response: z.object({ currency: Currency, accounts: z.array(LedgerAccount) }),
});

export const createAccount = endpoint({
  id: "ledger.accounts.create",
  method: "POST",
  path: "/api/v1/orgs/:orgId/ledger/accounts",
  auth: "user",
  summary:
    "Add an account. The first digit must match its type (1 asset, 2 liability, 3 equity, 4 income, 5–9 expense).",
  params: OrgParams,
  body: z.object({ code: AccountCode, name: z.string().trim().min(3).max(120), type: AccountType }),
  response: LedgerAccount,
  status: 201,
});

export const updateAccount = endpoint({
  id: "ledger.accounts.update",
  method: "PUT",
  path: "/api/v1/orgs/:orgId/ledger/accounts/:code",
  auth: "user",
  summary: "Rename an account, or deactivate it once its balance is zero",
  params: OrgParams.extend({ code: AccountCode }),
  body: z
    .object({ name: z.string().trim().min(3).max(120).optional(), active: z.boolean().optional() })
    .refine((b) => b.name !== undefined || b.active !== undefined, "Send a name or active"),
  response: LedgerAccount,
});

export const listJournals = endpoint({
  id: "ledger.journals.list",
  method: "GET",
  path: "/api/v1/orgs/:orgId/ledger/journals",
  auth: "user",
  summary: "Journals, newest first, optionally filtered",
  params: OrgParams,
  query: z.object({
    status: JournalStatus.optional(),
    from: IsoDate.optional(),
    to: IsoDate.optional(),
    limit: z.coerce.number().int().min(1).max(500).default(100),
  }),
  response: z.object({ journals: z.array(Journal) }),
});

export const getJournal = endpoint({
  id: "ledger.journals.get",
  method: "GET",
  path: "/api/v1/orgs/:orgId/ledger/journals/:journalId",
  auth: "user",
  summary: "One journal with its lines",
  params: JournalParams,
  response: Journal,
});

export const createJournal = endpoint({
  id: "ledger.journals.create",
  method: "POST",
  path: "/api/v1/orgs/:orgId/ledger/journals",
  auth: "user",
  summary: "Prepare a manual journal. It must balance, and someone else must approve it before it posts.",
  params: OrgParams,
  body: z.object({
    date: IsoDate,
    memo: z.string().trim().min(3).max(300),
    lines: z.array(JournalLineInput).min(2).max(200),
  }),
  response: Journal,
  status: 201,
});

export const approveJournal = endpoint({
  id: "ledger.journals.approve",
  method: "POST",
  path: "/api/v1/orgs/:orgId/ledger/journals/:journalId/approve",
  auth: "user",
  summary: "Approve and post a journal prepared by someone else",
  params: JournalParams,
  response: Journal,
});

export const rejectJournal = endpoint({
  id: "ledger.journals.reject",
  method: "POST",
  path: "/api/v1/orgs/:orgId/ledger/journals/:journalId/reject",
  auth: "user",
  summary: "Reject a journal awaiting approval, with a reason",
  params: JournalParams,
  body: z.object({ reason: Reason }),
  response: Journal,
});

export const reverseJournal = endpoint({
  id: "ledger.journals.reverse",
  method: "POST",
  path: "/api/v1/orgs/:orgId/ledger/journals/:journalId/reverse",
  auth: "user",
  summary: "Prepare the reversal of a posted journal (mirror lines). It needs approval like any manual journal.",
  params: JournalParams,
  body: z.object({ date: IsoDate, reason: Reason }),
  response: Journal,
  status: 201,
});

export const trialBalance = endpoint({
  id: "ledger.trialBalance",
  method: "GET",
  path: "/api/v1/orgs/:orgId/ledger/trial-balance",
  auth: "user",
  summary: "Debit and credit balance of every account from posted journals up to a date",
  params: OrgParams,
  query: z.object({ asOf: IsoDate.optional() }),
  response: z.object({
    asOf: IsoDate,
    currency: Currency,
    rows: z.array(
      z.object({
        code: AccountCode,
        name: z.string(),
        type: AccountType,
        debitMinor: MinorUnits,
        creditMinor: MinorUnits,
      }),
    ),
    totals: z.object({ debitMinor: MinorUnits, creditMinor: MinorUnits }),
    balanced: z.boolean(),
  }),
});

export const accountActivity = endpoint({
  id: "ledger.accounts.activity",
  method: "GET",
  path: "/api/v1/orgs/:orgId/ledger/accounts/:code/activity",
  auth: "user",
  summary: "Posted movements on one account between two dates, with opening and running balance",
  params: OrgParams.extend({ code: AccountCode }),
  query: z.object({ from: IsoDate, to: IsoDate }),
  response: z.object({
    account: LedgerAccount,
    openingMinor: MinorUnits,
    lines: z.array(
      z.object({
        date: IsoDate,
        journalId: z.string(),
        number: z.string(),
        memo: z.string(),
        debitMinor: MinorUnits,
        creditMinor: MinorUnits,
        balanceMinor: MinorUnits,
      }),
    ),
    closingMinor: MinorUnits,
  }),
});

export const Period = z.object({
  month: IsoMonth,
  status: z.enum(["open", "closed"]),
  changedBy: z.string().nullable(),
  changedAt: IsoDateTime.nullable(),
  reason: z.string().nullable(),
});

const PeriodParams = OrgParams.extend({ month: IsoMonth });

export const listPeriods = endpoint({
  id: "ledger.periods.list",
  method: "GET",
  path: "/api/v1/orgs/:orgId/ledger/periods",
  auth: "user",
  summary: "Months that have been closed or reopened (any other month is open)",
  params: OrgParams,
  response: z.object({ periods: z.array(Period) }),
});

export const closePeriod = endpoint({
  id: "ledger.periods.close",
  method: "POST",
  path: "/api/v1/orgs/:orgId/ledger/periods/:month/close",
  auth: "user",
  summary: "Close a month: nothing can post into it until it is reopened",
  params: PeriodParams,
  body: z.object({ reason: Reason }),
  response: Period,
});

export const reopenPeriod = endpoint({
  id: "ledger.periods.reopen",
  method: "POST",
  path: "/api/v1/orgs/:orgId/ledger/periods/:month/reopen",
  auth: "user",
  summary: "Reopen a closed month, with a reason kept in the audit log",
  params: PeriodParams,
  body: z.object({ reason: Reason }),
  response: Period,
});
