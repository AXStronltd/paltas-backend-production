import { beforeAll, afterAll, it, expect } from "vitest";
import { startPropertyServer, pmOrg } from "./support/property-fixture.js";
import { refused, type TestServer } from "./support/test-server.js";
let S: TestServer, o: Awaited<ReturnType<typeof pmOrg>>;
const account = "001234567890",
  params = () => ({ orgId: o.orgId });
const input = {
  expectedRevision: 0,
  kind: "bank" as const,
  accountHolder: "Synthetic Property Company",
  accountNumber: account,
  bankCode: "68",
  reason: "Register company receiving account",
  confirmAuthority: true as const,
};
beforeAll(async () => {
  S = await startPropertyServer();
  o = await pmOrg(S);
});
afterAll(() => S.close());
it("requires owner authority and isolates company receiving details", async () => {
  expect(await o.admin.api.rentCollection.receivingAccount({ params: params() })).toEqual({
    account: null,
    automaticSettlementEnabled: false,
    manualInstructionsEnabled: false,
  });
  await refused(o.staff.viewer.api.rentCollection.saveReceivingAccount({ params: params(), body: input }), 403);
  const other = await pmOrg(S);
  await refused(other.admin.api.rentCollection.receivingAccount({ params: params() }), 404);
});
it("stores encrypted bank details, returns only masked references and never enables collection", async () => {
  const r = await o.admin.api.rentCollection.saveReceivingAccount({ params: params(), body: input });
  expect(r).toMatchObject({
    automaticSettlementEnabled: false,
    account: { revision: 1, kind: "bank", accountMasked: "••••7890", status: "verification_pending" },
  });
  expect(JSON.stringify(r)).not.toContain(account);
  const stored = await S.sql<{ details_sealed: string }>(
    "SELECT details_sealed FROM pm_receiving_account_versions WHERE org_id=$1",
    [o.orgId],
  );
  expect(stored[0]!.details_sealed).not.toContain(account);
  expect(S.app.ctx.secrets.open(stored[0]!.details_sealed)).toContain(account);
  expect(await S.sql("SELECT id FROM pm_payments WHERE org_id=$1", [o.orgId])).toHaveLength(0);
  expect(await S.sql("SELECT org_id FROM pm_kulmipay_connections WHERE org_id=$1", [o.orgId])).toHaveLength(0);
});
it("reopens masked details, preserves the account on permitted edits, and rejects stale updates", async () => {
  const read = await o.admin.api.rentCollection.receivingAccount({ params: params() });
  expect(read.account!.revision).toBe(1);
  const { accountNumber: _number, ...withoutNumber } = input;
  void _number;
  const edited = await o.admin.api.rentCollection.saveReceivingAccount({
    params: params(),
    body: { ...withoutNumber, expectedRevision: 1, accountHolder: "Updated Company" },
  });
  expect(edited.account).toMatchObject({ revision: 2, accountHolder: "Updated Company", accountMasked: "••••7890" });
  await refused(
    o.admin.api.rentCollection.saveReceivingAccount({ params: params(), body: { ...input, expectedRevision: 1 } }),
    409,
  );
  expect(await S.sql("SELECT id FROM pm_receiving_account_versions WHERE org_id=$1", [o.orgId])).toHaveLength(2);
});
it("requires correct destination details and a new number when changing destination type", async () => {
  const { accountNumber: _number, ...withoutNumber } = input;
  void _number;
  await refused(
    o.admin.api.rentCollection.saveReceivingAccount({
      params: params(),
      body: { ...withoutNumber, expectedRevision: 2, kind: "mpesa_mobile", bankCode: undefined },
    }),
    409,
  );
  await refused(
    o.admin.api.rentCollection.saveReceivingAccount({
      params: params(),
      body: { ...input, expectedRevision: 2, kind: "mpesa_mobile", accountNumber: "254000000000", bankCode: undefined },
    }),
    409,
  );
  await refused(
    o.admin.api.rentCollection.saveReceivingAccount({
      params: params(),
      body: { ...input, expectedRevision: 2, kind: "mpesa_paybill", accountNumber: "123456", bankCode: undefined },
    }),
    409,
  );
});
it("supports M-Pesa destination revisions and pausing without losing financial history", async () => {
  const r = await o.admin.api.rentCollection.saveReceivingAccount({
    params: params(),
    body: { ...input, expectedRevision: 2, kind: "mpesa_mobile", accountNumber: "254712345678", bankCode: undefined },
  });
  expect(r.account).toMatchObject({
    revision: 3,
    kind: "mpesa_mobile",
    accountMasked: "••••5678",
    status: "verification_pending",
  });
  const paused = await o.admin.api.rentCollection.pauseReceivingAccount({
    params: params(),
    body: { expectedRevision: 3, reason: "Pause while company details are checked" },
  });
  expect(paused.account).toMatchObject({ revision: 4, status: "paused" });
  expect(await S.sql("SELECT id FROM pm_receiving_account_versions WHERE org_id=$1", [o.orgId])).toHaveLength(4);
  const audit = await S.sql<{ detail: string }>(
    "SELECT detail FROM audit_log WHERE org_id=$1 AND action LIKE 'Receiving%'",
    [o.orgId],
  );
  expect(audit.length).toBe(4);
  expect(JSON.stringify(audit)).not.toContain(account);
});

it("serializes concurrent corrections and preserves append-only history", async () => {
  const body = { ...input, expectedRevision: 4 };
  const results = await Promise.allSettled([
    o.admin.api.rentCollection.saveReceivingAccount({ params: params(), body }),
    o.admin.api.rentCollection.saveReceivingAccount({ params: params(), body }),
  ]);
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
  await expect(
    S.sql("UPDATE pm_receiving_account_versions SET status='paused' WHERE org_id=$1", [o.orgId]),
  ).rejects.toThrow(/append-only/);
  const r = await o.admin.api.rentCollection.receivingAccount({ params: params() });
  expect(r.account!.revision).toBe(5);
  expect(r.account!.status).toBe("verification_pending");
});
it("registers PayBill and Till details without treating them as verified", async () => {
  const r = await o.admin.api.rentCollection.saveReceivingAccount({
    params: params(),
    body: {
      ...input,
      expectedRevision: 5,
      kind: "mpesa_paybill",
      bankCode: undefined,
      accountNumber: "123456",
      accountReference: "SYNTHETICREF",
    },
  });
  expect(r.account).toMatchObject({ revision: 6, status: "verification_pending", accountReferenceMasked: "••••EF" });
  expect(JSON.stringify(r)).not.toContain("SYNTHETICREF");
  const t = await o.admin.api.rentCollection.saveReceivingAccount({
    params: params(),
    body: { ...input, expectedRevision: 6, kind: "mpesa_till", bankCode: undefined, accountNumber: "654321" },
  });
  expect(t.account.kind).toBe("mpesa_till");
});
