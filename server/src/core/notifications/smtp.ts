/*
 * A small SMTP client (RFC 5321) on node:net / node:tls — no dependency. Enough for one authenticated submission:
 *
 *   greeting 220 → EHLO → (port 587: STARTTLS → TLS → EHLO again; plain-text authentication is never sent)
 *   → AUTH PLAIN (or AUTH LOGIN) → MAIL FROM → RCPT TO → DATA (dot-stuffed) → QUIT
 *
 * Port 465 starts with TLS (implicit). Certificates are always verified. Every step has a timeout.
 * Outcome: the server's 250 after DATA = "accepted by the mail server" — SMTP never says more; there is no delivery
 * report. 4xx answers, timeouts and broken connections are temporary (the outbox tries again); 5xx answers are final.
 *
 * With Gmail: smtp.gmail.com:465, the account address as user and a Google "App password" (needs 2-step
 * verification on the account).
 */
import { randomBytes } from "node:crypto";
import net from "node:net";
import tls from "node:tls";

export interface SmtpOptions {
  host: string;
  port: number;
  /** true: TLS from the first byte (465); false: STARTTLS is required (587). */
  secure: boolean;
  user: string;
  password: string;
  timeoutMs?: number;
  /** Extra trusted certificate authority (tests: the fake server's own certificate). */
  ca?: string | Buffer;
}

export interface SmtpMessage {
  from: { name: string; address: string };
  to: string;
  replyTo: string;
  subject: string;
  text: string;
  /** Used as the Message-ID local part (the outbox id), so a message can be traced. */
  ref: string;
}

export type SmtpResult =
  | { ok: true; messageId: string; response: string }
  | { ok: false; transient: boolean; stage: string; response: string };

class SmtpFailure extends Error {
  constructor(
    readonly stage: string,
    readonly response: string,
    readonly transient: boolean,
  ) {
    super(`${stage}: ${response}`);
  }
}

// ---------------------------------------------------------------- MIME (UTF-8 text + HTML)

/** RFC 2047 encoded-word for a header value that is not plain ASCII. */
export function encodeHeader(v: string): string {
  const clean = v.replace(/[\r\n]+/g, " ");
  return /^[\x20-\x7e]*$/.test(clean) ? clean : `=?UTF-8?B?${Buffer.from(clean, "utf8").toString("base64")}?=`;
}

function address(name: string, addr: string) {
  const n = name.replace(/["\r\n<>]/g, "").trim();
  if (!n) return `<${addr}>`;
  const enc = encodeHeader(n);
  return `${enc === n ? `"${n}"` : enc} <${addr}>`;
}

const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** The plain message as simple HTML: paragraphs, line breaks and clickable links. */
export function htmlFromText(text: string): string {
  const paras = text
    .split(/\n{2,}/)
    .map((p) =>
      escapeHtml(p)
        .replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1">$1</a>')
        .replace(/\n/g, "<br>"),
    )
    .map((p) => `<p style="margin:0 0 16px">${p}</p>`)
    .join("\n");
  return `<!doctype html><html><body style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5;color:#1f2933">\n${paras}\n</body></html>`;
}

const b64lines = (s: string) =>
  (
    Buffer.from(s, "utf8")
      .toString("base64")
      .match(/.{1,76}/g) ?? [""]
  ).join("\r\n");

export function buildMime(m: SmtpMessage, messageId: string, date = new Date()): string {
  const boundary = "paltas-" + randomBytes(12).toString("hex");
  const headers = [
    `From: ${address(m.from.name, m.from.address)}`,
    `To: <${m.to}>`,
    `Reply-To: <${m.replyTo}>`,
    `Subject: ${encodeHeader(m.subject)}`,
    `Date: ${date.toUTCString().replace("GMT", "+0000")}`,
    `Message-ID: ${messageId}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
  ];
  const part = (type: string, body: string) => [
    `--${boundary}`,
    `Content-Type: ${type}; charset=UTF-8`,
    "Content-Transfer-Encoding: base64",
    "",
    b64lines(body),
  ];
  return [
    ...headers,
    "",
    ...part("text/plain", m.text),
    ...part("text/html", htmlFromText(m.text)),
    `--${boundary}--`,
    "",
  ].join("\r\n");
}

/** DATA transparency (RFC 5321 4.5.2): a line starting with "." gets one more. */
export const dotStuff = (data: string) =>
  data
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((l) => (l.startsWith(".") ? "." + l : l))
    .join("\r\n");

// ---------------------------------------------------------------- the conversation

class Conversation {
  private buf = "";
  private waiting: ((line: string | Error) => void) | null = null;
  private lines: string[] = [];
  private broken: Error | null = null;

  constructor(
    private socket: net.Socket | tls.TLSSocket,
    private timeoutMs: number,
  ) {
    this.attach(socket);
  }

  private attach(s: net.Socket | tls.TLSSocket) {
    s.setEncoding("utf8");
    s.on("data", (chunk: string) => {
      this.buf += chunk;
      let i: number;
      while ((i = this.buf.indexOf("\n")) >= 0) {
        const line = this.buf.slice(0, i).replace(/\r$/, "");
        this.buf = this.buf.slice(i + 1);
        this.push(line);
      }
    });
    const end = (err?: Error) => {
      this.broken = err ?? new Error("connection closed");
      this.waiting?.(this.broken);
      this.waiting = null;
    };
    s.on("error", end);
    s.on("close", () => end());
  }

  private push(line: string) {
    if (this.waiting) {
      const w = this.waiting;
      this.waiting = null;
      w(line);
    } else this.lines.push(line);
  }

  private nextLine(stage: string): Promise<string> {
    const queued = this.lines.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    if (this.broken) return Promise.reject(new SmtpFailure(stage, this.broken.message, true));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting = null;
        reject(new SmtpFailure(stage, `no answer within ${this.timeoutMs} ms`, true));
      }, this.timeoutMs);
      this.waiting = (l) => {
        clearTimeout(timer);
        if (l instanceof Error) reject(new SmtpFailure(stage, l.message, true));
        else resolve(l);
      };
    });
  }

  /** One (possibly multi-line) reply: "250-…" lines then "250 …". */
  async reply(stage: string, expect: number[]): Promise<{ code: number; lines: string[] }> {
    const lines: string[] = [];
    for (;;) {
      const l = await this.nextLine(stage);
      lines.push(l.slice(4));
      if (!/^\d{3}-/.test(l)) {
        const code = Number(l.slice(0, 3));
        const text = lines.join(" ").trim();
        if (!expect.includes(code)) throw new SmtpFailure(stage, `${code} ${text}`.trim(), !(code >= 500));
        return { code, lines };
      }
    }
  }

  send(line: string) {
    this.socket.write(line + "\r\n");
  }

  async command(stage: string, line: string, expect: number[]) {
    this.send(line);
    return this.reply(stage, expect);
  }

  /** Switch the same connection to TLS (STARTTLS). */
  async upgrade(o: SmtpOptions) {
    const plain = this.socket;
    plain.removeAllListeners("data");
    plain.removeAllListeners("error");
    plain.removeAllListeners("close");
    const secured = await new Promise<tls.TLSSocket>((resolve, reject) => {
      const s = tls.connect({ socket: plain, servername: o.host, ...(o.ca ? { ca: o.ca } : {}) }, () => resolve(s));
      s.once("error", (e) => reject(new SmtpFailure("STARTTLS", e.message, false)));
    });
    this.socket = secured;
    this.buf = "";
    this.lines = [];
    this.attach(secured);
  }

  close() {
    this.socket.destroy();
  }
}

function connect(o: SmtpOptions, timeoutMs: number): Promise<net.Socket | tls.TLSSocket> {
  return new Promise((resolve, reject) => {
    const s = o.secure
      ? tls.connect({ host: o.host, port: o.port, servername: o.host, ...(o.ca ? { ca: o.ca } : {}) })
      : net.connect({ host: o.host, port: o.port });
    const timer = setTimeout(() => {
      s.destroy();
      reject(new SmtpFailure("connect", `no connection within ${timeoutMs} ms`, true));
    }, timeoutMs);
    s.once(o.secure ? "secureConnect" : "connect", () => {
      clearTimeout(timer);
      resolve(s);
    });
    s.once("error", (e) => {
      clearTimeout(timer);
      // a certificate that does not verify is a set-up problem, not a passing one
      reject(new SmtpFailure("connect", e.message, !/certificate|self[- ]signed/i.test(e.message)));
    });
  });
}

/** Submit one message. Never throws: the result says accepted, temporary or final. */
export async function sendSmtp(o: SmtpOptions, m: SmtpMessage): Promise<SmtpResult> {
  const timeoutMs = o.timeoutMs ?? 20_000;
  const domain = m.from.address.split("@")[1] ?? "paltas.local";
  const messageId = `<${m.ref}.${randomBytes(6).toString("hex")}@${domain}>`;
  let c: Conversation | null = null;
  try {
    c = new Conversation(await connect(o, timeoutMs), timeoutMs);
    await c.reply("greeting", [220]);
    let ehlo = await c.command("EHLO", `EHLO ${domain}`, [250]);
    if (!o.secure) {
      if (!ehlo.lines.some((l) => /^STARTTLS\b/i.test(l)))
        throw new SmtpFailure(
          "STARTTLS",
          "the server does not offer STARTTLS — refusing to send the password in clear",
          false,
        );
      await c.command("STARTTLS", "STARTTLS", [220]);
      await c.upgrade(o);
      ehlo = await c.command("EHLO", `EHLO ${domain}`, [250]);
    }
    const auth = ehlo.lines.find((l) => /^AUTH\b/i.test(l))?.toUpperCase() ?? "";
    if (/\bPLAIN\b/.test(auth)) {
      const token = Buffer.from(`\u0000${o.user}\u0000${o.password}`, "utf8").toString("base64");
      await c.command("AUTH", `AUTH PLAIN ${token}`, [235]);
    } else if (/\bLOGIN\b/.test(auth)) {
      await c.command("AUTH", "AUTH LOGIN", [334]);
      await c.command("AUTH", Buffer.from(o.user, "utf8").toString("base64"), [334]);
      await c.command("AUTH", Buffer.from(o.password, "utf8").toString("base64"), [235]);
    } else throw new SmtpFailure("AUTH", "the server offers no supported sign-in (PLAIN or LOGIN)", false);
    await c.command("MAIL FROM", `MAIL FROM:<${m.from.address}>`, [250]);
    await c.command("RCPT TO", `RCPT TO:<${m.to}>`, [250, 251]);
    await c.command("DATA", "DATA", [354]);
    const done = await c.command("DATA", dotStuff(buildMime(m, messageId)) + "\r\n.", [250]);
    c.send("QUIT");
    return { ok: true, messageId, response: done.lines.join(" ").slice(0, 200) };
  } catch (err) {
    const f =
      err instanceof SmtpFailure ? err : new SmtpFailure("connection", (err as Error).message ?? String(err), true);
    return { ok: false, transient: f.transient, stage: f.stage, response: f.response.slice(0, 300) };
  } finally {
    c?.close();
  }
}
