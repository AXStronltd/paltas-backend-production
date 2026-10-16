import { describe, expect, it } from "vitest";
import { resendAdapter } from "../dist/core/notifications/resend.js";

const message = {
  id: "ntf-123",
  orgId: "org-1",
  channel: "email" as const,
  to: "customer@example.com",
  subject: "Verify your email",
  body: "Your private verification link",
  from: { name: "Untrusted", address: "untrusted@example.com", replyTo: "untrusted@example.com" },
};

describe("platform verification email adapter", () => {
  it("uses the fixed provider, platform sender and stable idempotency key", async () => {
    let calls = 0;
    const request: typeof fetch = async (url, init) => {
      calls++;
      expect(url).toBe("https://api.resend.com/emails");
      expect(init?.redirect).toBe("error");
      expect(init?.headers).toMatchObject({ "Idempotency-Key": "paltas/ntf-123" });
      expect(JSON.parse(String(init?.body))).toEqual({
        from: "verify@paltas.io",
        to: [message.to],
        subject: message.subject,
        text: message.body,
      });
      return new Response(JSON.stringify({ id: "provider-123" }));
    };
    const adapter = resendAdapter({ apiKey: "private-test-key", from: "verify@paltas.io" }, request);
    expect(await adapter.submit(message)).toMatchObject({ accepted: true, providerMessageId: "provider-123" });
    expect(calls).toBe(1);
  });

  it("does not expose provider response bodies or thrown secrets", async () => {
    for (const request of [
      async () => new Response("private-test-key", { status: 401 }),
      async () => {
        throw new Error("private-test-key");
      },
      async () => new Response(JSON.stringify({ id: "invalid\nreceipt" })),
    ]) {
      const adapter = resendAdapter({ apiKey: "private-test-key", from: "verify@paltas.io" }, request);
      const result = await adapter.submit(message);
      expect(result.accepted).toBe(false);
      expect(JSON.stringify(result)).not.toContain("private-test-key");
    }
  });
});
