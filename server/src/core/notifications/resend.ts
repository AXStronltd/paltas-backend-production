/** Platform verification mail only. Customer sender settings never control this identity. */
import type { NotificationAdapter } from "./adapters.js";

export function resendAdapter(
  settings: { apiKey: string; from: string },
  request: typeof fetch = fetch,
): NotificationAdapter {
  return {
    key: "platform_resend",
    channel: "email",
    label: "PALTAS verification email",
    connected: true,
    status: "Configured — delivery depends on provider acceptance and verified sending domain",
    async submit(message) {
      try {
        const response = await request("https://api.resend.com/emails", {
          method: "POST",
          redirect: "error",
          signal: AbortSignal.timeout(10_000),
          headers: {
            Authorization: `Bearer ${settings.apiKey}`,
            "Content-Type": "application/json",
            "Idempotency-Key": `paltas/${message.id}`,
          },
          body: JSON.stringify({
            from: settings.from,
            to: [message.to],
            subject: message.subject,
            text: message.body,
          }),
        });
        if (!response.ok) return { accepted: false, note: `Email provider refused submission (${response.status})` };
        const result: unknown = await response.json();
        if (
          !result ||
          typeof result !== "object" ||
          !("id" in result) ||
          typeof result.id !== "string" ||
          !/^[a-zA-Z0-9-]{1,128}$/.test(result.id)
        )
          return { accepted: false, note: "Email provider returned an invalid receipt" };
        return {
          accepted: true,
          providerMessageId: result.id,
          note: "Accepted by email provider; delivery not confirmed",
        };
      } catch {
        // Provider errors may contain credentials, recipients or single-use links. Never persist them.
        return { accepted: false, note: "Email submission could not be confirmed; retry is available" };
      }
    },
  };
}
