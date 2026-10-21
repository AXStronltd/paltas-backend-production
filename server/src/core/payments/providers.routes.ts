import { paymentProviders } from "@paltas/contracts";
import { route } from "../../http/route.js";
import { staffActor } from "../admin/admin.service.js";
import type { CoreServices } from "../core-services.js";
import type { SessionUser } from "../identity/identity.service.js";

// Provider webhooks are signature-checked by the route layer before these handlers run (auth "signed-webhook").
// The raw callback is kept exactly as received; the handlers work on the contract-checked body.
export function providersRoutes(core: CoreServices) {
  const { access, providers: P } = core;
  const raw = (b: Buffer | null, parsed: unknown): unknown => (b?.length ? JSON.parse(b.toString("utf8")) : parsed);
  const finance = async (user: SessionUser, orgId: string, write: boolean) => {
    const s = await access.scope(user, orgId, { capability: "payments.reconcile", write, anyProduct: true });
    return { orgId: s.orgId, userId: s.userId, actor: s.actor };
  };
  const paltas = (user: SessionUser, change: boolean) => ({
    orgId: null,
    userId: user.id,
    actor: change ? staffActor(user, "platform.operate") : staffActor(user),
  });

  return [
    route(paymentProviders.listAdapters, async () => ({ adapters: P.adapters() })),
    route(paymentProviders.mpesaCallback, async (req) => {
      const r = await P.mpesa(req.params.provider, raw(req.rawBody, req.body), req.body);
      return { ResultCode: 0 as const, ResultDesc: "Accepted", outcome: r.outcome };
    }),
    route(paymentProviders.cardEvent, async (req) => {
      const r = await P.card(req.params.provider, raw(req.rawBody, req.body), req.body);
      return { received: true as const, outcome: r.outcome, note: r.note };
    }),
    route(paymentProviders.listReferences, async (req) => {
      await finance(req.user, req.params.orgId, false);
      return { references: await P.references(req.params.orgId, req.query.status) };
    }),
    route(paymentProviders.importStatement, async (req) =>
      P.importStatement(await finance(req.user, req.params.orgId, true), req.body),
    ),
    route(paymentProviders.listStatements, async (req) => {
      await finance(req.user, req.params.orgId, false);
      return { statements: await P.statements(req.params.orgId) };
    }),
    route(paymentProviders.getStatement, async (req) =>
      P.statement(await finance(req.user, req.params.orgId, false), req.params.statementId),
    ),
    route(paymentProviders.confirmLine, async (req) =>
      P.confirmLine(
        await finance(req.user, req.params.orgId, true),
        req.params.statementId,
        req.params.lineId,
        req.body,
      ),
    ),
    route(paymentProviders.ignoreLine, async (req) =>
      P.ignoreLine(
        await finance(req.user, req.params.orgId, true),
        req.params.statementId,
        req.params.lineId,
        req.body.reason,
      ),
    ),
    route(paymentProviders.adminImportStatement, async (req) => P.importStatement(paltas(req.user, true), req.body)),
    route(paymentProviders.adminGetStatement, async (req) =>
      P.statement(paltas(req.user, false), req.params.statementId),
    ),
    route(paymentProviders.adminConfirmLine, async (req) =>
      P.confirmLine(paltas(req.user, true), req.params.statementId, req.params.lineId, req.body),
    ),
  ];
}
