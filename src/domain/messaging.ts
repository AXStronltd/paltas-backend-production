import type { Env } from "../config.ts";
import { messageOf } from "../http/errors.ts";

/** A provider's own words, if it sent any. Theirs beat ours. */
const said = (v: unknown): string => (typeof v === "string" ? v : "");

/* ====================================================================== *
 * WHO ACTUALLY DELIVERS A MESSAGE, AND WHAT THIS SERVICE MAY CLAIM.
 *
 * ── THE ONE RULE ───────────────────────────────────────────────────────
 *
 * THIS SERVICE MAY NEVER WRITE "DELIVERED". It does not know. Only the thing
 * that carried the message knows, and it tells us afterwards through a
 * callback — which is why `markDelivered` lives in the webhook and nowhere
 * else in this file.
 *
 * What this file decides is narrower and completely knowable: did anything
 * ACCEPT the message. Three answers, and they are genuinely different:
 *
 *   accepted        a provider took it and gave back its own id. SUBMITTED.
 *   not configured  there is no provider. The message stays QUEUED, which is
 *                   an honest state — it exists, it is meant to go, and
 *                   nothing has taken it. Nobody is told it was sent.
 *   refused         a provider was asked and said no, in its own words. FAILED.
 *
 * ── WHY IT IS BUILT THIS WAY WITH NO CREDENTIALS IN THE ACCOUNT ─────────
 *
 * Because the alternative is a button that writes SENT and a screen full of
 * messages nobody received. A company would find out when a buyer says they
 * never got the offer. So the not-configured path is a first-class outcome
 * with its own state and its own sentence, rather than an error case bolted
 * on later: the day a provider IS connected, nothing above this file changes.
 * ====================================================================== */

/**
 * The providers this service knows how to talk to, in the order it prefers
 * them. Each one is only usable if its own secret is in the environment.
 *
 * Adding a provider is adding an entry here. Nothing else in the service
 * names a provider.
 */
/**
 * A credential `usable()` has already proved is there.
 *
 * providerFor() refuses to return a provider whose key is missing, so by the
 * time send() runs these are all set — but that is a runtime check the
 * compiler cannot follow into another function. Checking again is cheap, and
 * the message names the real mistake: a provider listing a credential in
 * `key`/`also` that it then does not read, or reading one it never listed.
 */
function credential(env: Env, key: string): string {
  const v = env[key];
  if (v === undefined || v.trim() === "") {
    throw new Error(
      `${key} is read while sending but is not among the credentials this ` +
      `provider declares, so nothing checked it before the attempt.`);
  }
  return v;
}

/** One message, as a provider needs it. */
export interface OutboundMessage {
  readonly to: string;
  readonly subject?: string;
  readonly body?: string;
}

/**
 * One provider this service knows how to talk to.
 *
 * `key` is the secret that makes it usable; `also` names anything else it
 * needs, because two out of three credentials is a 401 at the worst moment.
 */
interface Provider {
  readonly name: string;
  readonly key: string;
  readonly also?: readonly string[];
  send(env: Env, msg: OutboundMessage): Promise<{ id: string }>;
}

const EMAIL_PROVIDERS: readonly Provider[] = [
  {
    name: "resend",
    key: "RESEND_API_KEY",
    /** @returns {Promise<{id: string}>} whatever the provider calls it. */
    async send(env: Env, msg: OutboundMessage): Promise<{ id: string }> {
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          authorization: `Bearer ${credential(env, "RESEND_API_KEY")}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          from: credential(env, "MAIL_FROM"),
          to: [msg.to],
          subject: msg.subject ?? "",
          text: msg.body ?? "",
        }),
      });
      const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok) {
        /* The provider's own sentence. Ours would be a guess, and a guess in
           an error log is what turns a five-minute fix into an afternoon. */
        throw new Error(said(body["message"]) || `${res.status} from Resend`);
      }
      return { id: String(body["id"] || "") };
    },
  },
  {
    name: "postmark",
    key: "POSTMARK_TOKEN",
    async send(env: Env, msg: OutboundMessage): Promise<{ id: string }> {
      const res = await fetch("https://api.postmarkapp.com/email", {
        method: "POST",
        headers: {
          "X-Postmark-Server-Token": credential(env, "POSTMARK_TOKEN"),
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify({
          From: credential(env, "MAIL_FROM"),
          To: msg.to,
          Subject: msg.subject ?? "",
          TextBody: msg.body ?? "",
          MessageStream: env["POSTMARK_STREAM"] || "outbound",
        }),
      });
      const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok) throw new Error(said(body["Message"]) || `${res.status} from Postmark`);
      return { id: String(body["MessageID"] || "") };
    },
  },
];

const SMS_PROVIDERS: readonly Provider[] = [
  {
    name: "twilio",
    key: "TWILIO_AUTH_TOKEN",
    /* Also needs the account sid and a from-number; `usable` below checks all
       three, because two out of three is a 401 at the worst moment. */
    also: ["TWILIO_ACCOUNT_SID", "TWILIO_FROM"],
    async send(env: Env, msg: OutboundMessage): Promise<{ id: string }> {
      const sid = credential(env, "TWILIO_ACCOUNT_SID");
      const res = await fetch(
        `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}/Messages.json`,
        {
          method: "POST",
          headers: {
            authorization: "Basic " +
              Buffer.from(`${sid}:${credential(env, "TWILIO_AUTH_TOKEN")}`).toString("base64"),
            "content-type": "application/x-www-form-urlencoded",
          },
          body: new URLSearchParams({
            From: credential(env, "TWILIO_FROM"), To: msg.to, Body: msg.body ?? "",
          }).toString(),
        },
      );
      const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok) throw new Error(said(body["message"]) || `${res.status} from Twilio`);
      return { id: String(body["sid"] || "") };
    },
  },
];

const BY_CHANNEL: Readonly<Record<string, readonly Provider[]>> = {
  EMAIL: EMAIL_PROVIDERS,
  SMS: SMS_PROVIDERS,
  /* Nothing carries WhatsApp for this service yet. Declared so the channel is
     a real choice with an honest answer rather than a 500. */
  WHATSAPP: [],
  /* IN_APP is carried by this service. It has no provider because it needs
     none — see deliver() below, which is the only place DELIVERED is written
     outside a provider callback, and may be because we are the provider. */
  IN_APP: [],
};

function usable(p: Provider, env: Env): boolean {
  if (!env[p.key]) return false;
  return (p.also || []).every((k) => !!env[k]);
}

/**
 * Which provider would carry this channel, or null.
 *
 * `MAIL_FROM` is required alongside an email provider: every one of them
 * refuses a send with no from-address, and finding that out per message means
 * a queue of failures instead of one honest "not configured".
 */
export function providerFor(channel: string, env: Env = process.env): Provider | null {
  const list = BY_CHANNEL[channel] || [];
  for (const p of list) {
    if (!usable(p, env)) continue;
    if (channel === "EMAIL" && !env["MAIL_FROM"]) continue;
    return p;
  }
  return null;
}

/** What is connected, for a settings screen to show plainly. */
export function providerStatus(env: Env = process.env) {
  const out: Record<string, unknown> = {};
  for (const channel of Object.keys(BY_CHANNEL)) {
    const p = providerFor(channel, env);
    out[channel] = {
      configured: channel === "IN_APP" ? true : !!p,
      provider: channel === "IN_APP" ? "paltas" : (p ? p.name : null),
      /* The names somebody has to set. Said out loud so a person configuring
         this does not have to read this file to find out. */
      needs: channel === "IN_APP" ? [] : (BY_CHANNEL[channel] || []).map((x) =>
        [x.key, ...(x.also || []), ...(channel === "EMAIL" ? ["MAIL_FROM"] : [])]),
    };
  }
  return out;
}

/**
 * Hand one message to whoever carries it.
 *
 * NEVER THROWS. A send that blows up mid-campaign would leave a batch half
 * attempted with no record of which half; every outcome is a returned value,
 * and the caller writes it down.
 *
 * @returns {Promise<{outcome: "accepted"|"unconfigured"|"refused"|"delivered",
 *                    provider: string, providerRef: string, detail: string}>}
 */
export async function deliver(
  channel: string,
  msg: OutboundMessage,
  env: Env = process.env,
): Promise<DeliveryOutcome> {
  /*
   * IN_APP IS THE ONE CHANNEL THIS SERVICE MAY CALL DELIVERED.
   *
   * Because it is the carrier: the message is a row in its own database, and
   * a row that exists has arrived. Every other channel leaves the building.
   */
  if (channel === "IN_APP") {
    return { outcome: "delivered", provider: "paltas", providerRef: "",
             detail: "Shown inside PALTAS." };
  }

  const p = providerFor(channel, env);
  if (!p) {
    return {
      outcome: "unconfigured", provider: "", providerRef: "",
      detail: `No ${channel.toLowerCase()} provider is connected, so nothing has been sent. ` +
              `The message is queued and will go when one is.`,
    };
  }

  if (!msg.to) {
    return { outcome: "refused", provider: p.name, providerRef: "",
             detail: "There is no address to send to." };
  }

  try {
    const { id } = await p.send(env, msg);
    return {
      outcome: "accepted", provider: p.name, providerRef: id,
      /* Deliberately not "sent". It was taken, which is a different claim. */
      detail: `Accepted by ${p.name}. Delivery is confirmed separately.`,
    };
  } catch (e) {
    return { outcome: "refused", provider: p.name, providerRef: "",
             detail: messageOf(e, "The provider refused it.") };
  }
}

/** What happened when something was handed to a carrier. */
export interface DeliveryOutcome {
  readonly outcome: "accepted" | "unconfigured" | "refused" | "delivered";
  readonly provider: string;
  readonly providerRef: string;
  readonly detail: string;
}

/** The state an outcome puts a dispatch into. One table, so it cannot drift. */
export const STATUS_FOR = {
  accepted: "SUBMITTED",
  unconfigured: "QUEUED",
  refused: "FAILED",
  delivered: "DELIVERED",
};
