import { ledger } from "@paltas/contracts";
import type { CoreServices } from "../core-services.js";
import { route } from "../../http/route.js";

// Reading the ledger needs ledger.read. Changing it needs the role's capability, an active subscription and the
// Finance and Accounting module on any of the organisation's products.
const WRITE = { write: true, module: "finance", anyProduct: true } as const;

export function ledgerRoutes(core: CoreServices) {
  const { access, ledger: L } = core;
  return [
    route(ledger.financialStatements, async (req) => {
      await access.scope(req.user, req.params.orgId, { capability: "ledger.read" });
      return L.financialStatements(req.params.orgId, req.query.from, req.query.to);
    }),
    route(ledger.listAccounts, async (req) => {
      await access.scope(req.user, req.params.orgId, { capability: "ledger.read" });
      return L.listAccounts(req.params.orgId);
    }),
    route(ledger.createAccount, async (req) => {
      const s = await access.scope(req.user, req.params.orgId, { capability: "ledger.accounts.manage", ...WRITE });
      return L.createAccount(s, req.body);
    }),
    route(ledger.updateAccount, async (req) => {
      const s = await access.scope(req.user, req.params.orgId, { capability: "ledger.accounts.manage", ...WRITE });
      return L.updateAccount(s, req.params.code, req.body);
    }),
    route(ledger.accountActivity, async (req) => {
      await access.scope(req.user, req.params.orgId, { capability: "ledger.read" });
      return L.accountActivity(req.params.orgId, req.params.code, req.query.from, req.query.to);
    }),
    route(ledger.listJournals, async (req) => {
      await access.scope(req.user, req.params.orgId, { capability: "ledger.read" });
      return { journals: await L.listJournals(req.params.orgId, req.query) };
    }),
    route(ledger.getJournal, async (req) => {
      await access.scope(req.user, req.params.orgId, { capability: "ledger.read" });
      return L.getJournal(req.params.orgId, req.params.journalId);
    }),
    route(ledger.createJournal, async (req) => {
      const s = await access.scope(req.user, req.params.orgId, { capability: "ledger.prepare", ...WRITE });
      return L.prepareJournal(s, req.body);
    }),
    route(ledger.approveJournal, async (req) => {
      const s = await access.scope(req.user, req.params.orgId, { capability: "ledger.approve", ...WRITE });
      return L.approveJournal(s, req.params.journalId);
    }),
    route(ledger.rejectJournal, async (req) => {
      const s = await access.scope(req.user, req.params.orgId, { capability: "ledger.approve", ...WRITE });
      return L.rejectJournal(s, req.params.journalId, req.body.reason);
    }),
    route(ledger.reverseJournal, async (req) => {
      const s = await access.scope(req.user, req.params.orgId, { capability: "ledger.prepare", ...WRITE });
      return L.reverseJournal(s, req.params.journalId, req.body);
    }),
    route(ledger.trialBalance, async (req) => {
      await access.scope(req.user, req.params.orgId, { capability: "ledger.read" });
      return L.trialBalance(req.params.orgId, req.query.asOf);
    }),
    route(ledger.listPeriods, async (req) => {
      await access.scope(req.user, req.params.orgId, { capability: "ledger.read" });
      return { periods: await L.listPeriods(req.params.orgId) };
    }),
    route(ledger.closePeriod, async (req) => {
      const s = await access.scope(req.user, req.params.orgId, { capability: "ledger.periods.close", ...WRITE });
      return L.closePeriod(s, req.params.month, req.body.reason);
    }),
    route(ledger.reopenPeriod, async (req) => {
      const s = await access.scope(req.user, req.params.orgId, { capability: "ledger.periods.close", ...WRITE });
      return L.reopenPeriod(s, req.params.month, req.body.reason);
    }),
  ];
}
