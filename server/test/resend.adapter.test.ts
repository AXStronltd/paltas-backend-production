import { describe, expect, it } from "vitest";
import { loadConfig } from "../dist/config.js";
import { emailAdapter } from "../dist/core/notifications/email-providers.js";

const message = {
  id: "ntf-123",
  orgId: "org-1",
  channel: "email" as const,
  to: "customer@example.com",
  subject: "Verify your email",
  body: "Your private verification link",
  from: { name: "", address: "", replyTo: "" },
};

const settings = () => {
  const email = loadConfig({
    NODE_ENV: "test",
    DATABASE_URL: "postgres://unused",
    PLATFORM_EMAIL_PROVIDER: "resend",
    RESEND_API_KEY: "private-test-key",
    PLATFORM_EMAIL_FROM: "PALTAS <verify@paltas.io>",
  }).email;
  return { ...email, provider: "resend" as const };
};

describe("platform e-mail adapter (Resend)", () => {
  it("uses the fixed provider, the platform sender and a stable idempotency key", async () => {
    let calls = 0;
    const request: typeof fetch = async (url, init) => {
      calls++;
      expect(url).toBe("https://api.resend.com/emails");
      expect(init?.headers).toMatchObject({ "Idempotency-Key": "ntf-123", Authorization: "Bearer private-test-key" });
      expect(JSON.parse(String(init?.body))).toMatchObject({
        from: '"PALTAS" <verify@paltas.io>',
        to: [message.to],
        subject: message.subject,
        text: message.body,
      });
      return new Response(JSON.stringify({ id: "provider-123" }));
    };
    const adapter = emailAdapter(settings(), { fetch: request });
    expect(adapter.key).toBe("platform_resend");
    expect(await adapter.submit(message)).toMatchObject({
      accepted: true,
      sent: true,
      providerMessageId: "provider-123",
    });
    expect(calls).toBe(1);
  });

  it("does not expose the key; a refusal fails and a network error is retried", async () => {
    const refusedBy = emailAdapter(settings(), { fetch: async () => new Response("{}", { status: 401 }) });
    const refusal = await refusedBy.submit(message);
    expect(refusal).toMatchObject({ accepted: false });
    expect("retry" in refusal && refusal.retry).toBeFalsy();
    const unreachable = emailAdapter(settings(), {
      fetch: async () => {
        throw new Error("connect failed");
      },
    });
    const network = await unreachable.submit(message);
    expect(network).toMatchObject({ accepted: false, retry: true });
    for (const r of [refusal, network]) expect(JSON.stringify(r)).not.toContain("private-test-key");
  });
});
