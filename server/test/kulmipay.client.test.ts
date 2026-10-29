import { expect, it } from "vitest";
import {
  kulmiPayClient,
  checkedKulmiCollection,
  verifyKulmiChallenge,
  type KulmiCredentials,
} from "../dist/core/payments/kulmipay/client.js";
const c: KulmiCredentials = {
  environment: "sandbox",
  secretKey: "ISSecretKey_test_syntheticOnly",
  walletId: "wallet_synthetic",
};
const expected = {
  invoiceId: "provider_invoice",
  reference: "paltas_request",
  amountMinor: 120000,
  provider: "M-PESA" as const,
};
const invoice = {
  invoice_id: expected.invoiceId,
  api_ref: expected.reference,
  value: "1200.00",
  currency: "KES",
  provider: "M-PESA",
  state: "COMPLETE",
  charges: "30.00",
  net_amount: "1170.00",
  clearing_status: "AVAILABLE",
  mpesa_reference: "receipt_example",
};
it("confirms exact collection, fees and net separately from settlement", () => {
  expect(checkedKulmiCollection(invoice, expected)).toMatchObject({
    confirmed: true,
    amountMinor: 120000,
    feeMinor: 3000,
    netMinor: 117000,
    clearingStatus: "AVAILABLE",
  });
  for (const state of ["PENDING", "PROCESSING", "PARTIAL", "FAILED", "CANCELED", "RETRY"])
    expect(checkedKulmiCollection({ ...invoice, state }, expected).confirmed).toBe(false);
});
it("rejects foreign references, identities, currencies and inconsistent money", () => {
  for (const change of [
    { invoice_id: "foreign" },
    { api_ref: "foreign" },
    { currency: "USD" },
    { value: "1200.001" },
    { value: "0" },
    { provider: "PESALINK" },
    { charges: "30.01" },
    { net_amount: "1170.001" },
    { charges: "-1" },
    { charges: "1201" },
  ])
    expect(() => checkedKulmiCollection({ ...invoice, ...change }, expected)).toThrow();
});
it("uses pinned sandbox host, client secret and wallet; never follows redirects", async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const client = kulmiPayClient(async (url, init) => {
    calls.push({ url, init });
    return Response.json({ invoice: { ...invoice, state: "PENDING", api_ref: "paltas_request" } });
  });
  const r = await client.initiate(c, {
    provider: "M-PESA",
    reference: "paltas_request",
    amountMinor: 120000,
    phone: "254712345678",
  });
  expect(r.confirmed).toBe(false);
  expect(calls[0]?.url).toBe("https://sandbox.kulmipay.com/api/v1/payment/mpesa-stk-push/");
  expect(calls[0]?.init.redirect).toBe("error");
  expect(JSON.parse(String(calls[0]?.init.body))).toMatchObject({
    wallet_id: c.walletId,
    amount: "1200.00",
    mobile_tarrif: "BUSINESS-PAYS",
  });
});
it("refuses STK rounding, invalid phone, and mixed live/test credentials before network calls", async () => {
  let calls = 0;
  const client = kulmiPayClient(async () => {
    calls++;
    return Response.json({});
  });
  for (const input of [
    { provider: "M-PESA" as const, amountMinor: 120001, reference: "ref", phone: "254712345678" },
    { provider: "M-PESA" as const, amountMinor: 120000, reference: "ref", phone: "0712345678" },
  ])
    await expect(client.initiate(c, input)).rejects.toThrow();
  await expect(client.verifyWallet({ ...c, environment: "live" })).rejects.toThrow();
  expect(calls).toBe(0);
});
it("sanitises failures, does not retry uncertain creation, and bounds response size", async () => {
  let calls = 0;
  const client = kulmiPayClient(async () => {
    calls++;
    throw new Error(c.secretKey);
  });
  await expect(
    client.initiate(c, { provider: "M-PESA", reference: "ref", amountMinor: 100, phone: "254712345678" }),
  ).rejects.toThrow(/do not retry/);
  expect(calls).toBe(1);
  const denied = kulmiPayClient(async () => new Response(c.secretKey, { status: 401 }));
  await expect(denied.verifyWallet(c)).rejects.toThrow("KulmiPay could not complete the request");
  const huge = kulmiPayClient(async () => new Response(" ".repeat(256001)));
  await expect(huge.verifyWallet(c)).rejects.toThrow(/unsupported response/);
});
it("verifies challenge without accepting empty, wrong or oversized values", () => {
  const challenge = "synthetic-challenge-value-at-least-32-characters";
  expect(verifyKulmiChallenge(challenge, challenge)).toBe(true);
  for (const value of [undefined, "", challenge + "x", "x".repeat(257)])
    expect(verifyKulmiChallenge(challenge, value)).toBe(false);
  expect(verifyKulmiChallenge("short", "short")).toBe(false);
});
it("supports PesaLink without currency conversion and validates wallet ownership response", async () => {
  const client = kulmiPayClient(async (url, init) => {
    if (url.includes("wallets/")) return Response.json({ wallet_id: c.walletId, currency: "KES" });
    expect(JSON.parse(String(init.body))).toMatchObject({
      method: "PESALINK",
      currency: "KES",
      wallet_id: c.walletId,
      bank_tarrif: "BUSINESS-PAYS",
    });
    return Response.json({
      invoice: { ...invoice, invoice_id: undefined, id: invoice.invoice_id, provider: "PESALINK", state: "PENDING" },
    });
  });
  await client.verifyWallet(c);
  expect(
    (await client.initiate(c, { provider: "PESALINK", amountMinor: 120000, reference: "paltas_request" })).provider,
  ).toBe("PESALINK");
});
