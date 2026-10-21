/*
 * The PALTAS assistant: one call to the Anthropic Messages API per client message.
 *
 * - The key comes only from the server's environment (SUPPORT_AI_API_KEY); it is never logged or returned.
 * - A reply that should go to a person ends with the line [[HANDOVER]] (removed before the client sees it).
 * - Any failure (no key, timeout, provider error) is reported as null: the caller hands the conversation to the
 *   PALTAS team instead of showing an error or an invented answer.
 * - Tests inject their own assistant (AppOptions.supportAssistant); nothing here reaches the network in tests.
 */
export interface AssistantTurn {
  role: "user" | "assistant";
  content: string;
}
export interface AssistantReply {
  text: string;
  handover: boolean;
  model: string;
}
export type SupportAssistant = (input: { system: string; turns: AssistantTurn[] }) => Promise<AssistantReply | null>;

export const HANDOVER = "[[HANDOVER]]";
const TIMEOUT_MS = 25_000;

/** Turn the model's text into what the client sees, and whether a person should take over. */
export function readReply(raw: string, model: string): AssistantReply | null {
  const handover = raw.includes(HANDOVER);
  const text = raw.split(HANDOVER).join("").trim().slice(0, 4000);
  if (!text && !handover) return null;
  return { text, handover, model };
}

export function anthropicAssistant(
  cfg: { apiKey: string | undefined; model: string; baseUrl?: string | undefined },
  log: { warn(o: object, msg: string): void },
  fetchImpl: typeof fetch = fetch,
): SupportAssistant | null {
  if (!cfg.apiKey) return null;
  const key = cfg.apiKey;
  return async ({ system, turns }) => {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
    try {
      const r = await fetchImpl(`${cfg.baseUrl ?? "https://api.anthropic.com"}/v1/messages`, {
        method: "POST",
        signal: ctl.signal,
        headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
        body: JSON.stringify({ model: cfg.model, max_tokens: 800, system, messages: turns }),
      });
      if (!r.ok) {
        log.warn({ status: r.status }, "PALTAS assistant: the AI provider refused the request");
        return null;
      }
      const body = (await r.json()) as { content?: { type: string; text?: string }[]; model?: string };
      const raw = (body.content ?? [])
        .filter((c) => c.type === "text")
        .map((c) => c.text ?? "")
        .join("");
      return readReply(raw, body.model ?? cfg.model);
    } catch (e) {
      log.warn({ error: (e as Error).name }, "PALTAS assistant: no answer from the AI provider");
      return null;
    } finally {
      clearTimeout(timer);
    }
  };
}

/** Client, assistant, staff and system messages as alternating turns the model accepts (starting and ending with the client). */
export function toTurns(
  messages: { author: "client" | "assistant" | "staff" | "system"; authorName: string; body: string }[],
): AssistantTurn[] {
  const out: AssistantTurn[] = [];
  for (const m of messages) {
    const role = m.author === "client" ? "user" : "assistant";
    const content =
      m.author === "staff" ? `(${m.authorName}) ${m.body}` : m.author === "system" ? `(PALTAS) ${m.body}` : m.body;
    const last = out[out.length - 1];
    if (last && last.role === role) last.content += "\n\n" + content;
    else out.push({ role, content });
  }
  while (out.length && out[0]?.role !== "user") out.shift();
  return out;
}
