/*
 * LOCAL FAKE e-mail providers for tests — nothing here talks to a real provider or sends real mail.
 *
 *   fakeSmtp()          a tiny SMTP server on 127.0.0.1/localhost with the self-signed test certificate in
 *                       test/fixtures/fake-smtp (STARTTLS like port 587, or implicit TLS like port 465), AUTH PLAIN /
 *                       LOGIN against one account, and scripted temporary failures; it records every message.
 *   fakeHttpProvider()  an HTTP server answering like the Resend / Postmark / SendGrid send APIs, recording requests.
 */
import { readFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import tls from "node:tls";
import { fileURLToPath } from "node:url";

const dir = fileURLToPath(new URL("../fixtures/fake-smtp/", import.meta.url));
export const FAKE_SMTP_CERT = readFileSync(dir + "cert.pem");
const KEY = readFileSync(dir + "key.pem");

export interface FakeSmtpOptions {
  /** "starttls": plain first, STARTTLS offered (587); "implicit": TLS from the first byte (465). */
  mode: "starttls" | "implicit";
  user: string;
  password: string;
  mechanisms?: ("PLAIN" | "LOGIN")[];
  /** Answer the end of DATA with "451" this many times before accepting. */
  tempFailures?: number;
  /** Do not offer STARTTLS (a server that would take the password in clear). */
  noStartTls?: boolean;
}

export interface FakeSmtp {
  port: number;
  messages: { from: string; to: string[]; data: string; tls: boolean; authUser: string }[];
  authFailures: number;
  close(): Promise<void>;
}

export async function fakeSmtp(o: FakeSmtpOptions): Promise<FakeSmtp> {
  const state: FakeSmtp = { port: 0, messages: [], authFailures: 0, close: async () => undefined };
  let failuresLeft = o.tempFailures ?? 0;
  const mechs = o.mechanisms ?? ["PLAIN", "LOGIN"];

  const session = (start: net.Socket | tls.TLSSocket, secure: boolean) => {
    let sock = start;
    let isTls = secure;
    let authed = "";
    let from = "";
    let to: string[] = [];
    let inData = false;
    let data: string[] = [];
    let loginStep: "" | "user" | "pass" = "";
    let loginUser = "";
    let buf = "";
    const say = (l: string) => sock.write(l + "\r\n");
    const ehlo = () => {
      const caps = ["250-fake-smtp.test (LOCAL FAKE SMTP — test only)"];
      if (!isTls && !o.noStartTls) caps.push("250-STARTTLS");
      if (isTls || o.noStartTls) caps.push(`250-AUTH ${mechs.join(" ")}`);
      caps.push("250 8BITMIME");
      caps.forEach(say);
    };
    const check = (user: string, pass: string) => {
      if (user === o.user && pass === o.password) {
        authed = user;
        say("235 2.7.0 Accepted");
      } else {
        state.authFailures++;
        say("535 5.7.8 Username and Password not accepted");
      }
    };
    const onLine = (line: string) => {
      if (inData) {
        if (line === ".") {
          inData = false;
          if (failuresLeft > 0) {
            failuresLeft--;
            say("451 4.3.0 Temporary local problem, try again");
          } else {
            state.messages.push({ from, to, data: data.join("\r\n"), tls: isTls, authUser: authed });
            say("250 2.0.0 OK queued as FAKE" + state.messages.length);
          }
          data = [];
        } else data.push(line.startsWith("..") ? line.slice(1) : line);
        return;
      }
      if (loginStep === "user") {
        loginUser = Buffer.from(line, "base64").toString("utf8");
        loginStep = "pass";
        return say("334 UGFzc3dvcmQ6");
      }
      if (loginStep === "pass") {
        loginStep = "";
        return check(loginUser, Buffer.from(line, "base64").toString("utf8"));
      }
      const [verb = "", ...rest] = line.split(" ");
      const arg = rest.join(" ");
      switch (verb.toUpperCase()) {
        case "EHLO":
          return ehlo();
        case "STARTTLS": {
          say("220 2.0.0 Ready to start TLS");
          const plain = sock;
          plain.removeAllListeners("data");
          const secured = new tls.TLSSocket(plain, { isServer: true, key: KEY, cert: FAKE_SMTP_CERT });
          sock = secured;
          isTls = true;
          buf = "";
          secured.on("data", onData);
          secured.on("error", () => undefined);
          return;
        }
        case "AUTH": {
          const [mech, initial] = arg.split(" ");
          if (!isTls && !o.noStartTls) return say("530 5.7.0 Must issue a STARTTLS command first");
          if (mech === "PLAIN" && mechs.includes("PLAIN")) {
            const [, u = "", p = ""] = Buffer.from(initial ?? "", "base64")
              .toString("utf8")
              .split("\u0000");
            return check(u, p);
          }
          if (mech === "LOGIN" && mechs.includes("LOGIN")) {
            loginStep = "user";
            return say("334 VXNlcm5hbWU6");
          }
          return say("504 5.5.4 Unrecognized authentication type");
        }
        case "MAIL":
          if (!authed) return say("530 5.7.0 Authentication Required");
          from = /<([^>]*)>/.exec(arg)?.[1] ?? "";
          to = [];
          return say("250 2.1.0 OK");
        case "RCPT":
          to.push(/<([^>]*)>/.exec(arg)?.[1] ?? "");
          return say("250 2.1.5 OK");
        case "DATA":
          inData = true;
          return say("354 Go ahead");
        case "QUIT":
          say("221 2.0.0 closing connection");
          return sock.end();
        default:
          return say("502 5.5.1 Unrecognized command");
      }
    };
    const onData = (chunk: Buffer) => {
      buf += chunk.toString("utf8");
      let i: number;
      while ((i = buf.indexOf("\r\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        onLine(line);
      }
    };
    sock.on("data", onData);
    sock.on("error", () => undefined);
    say("220 fake-smtp.test ESMTP LOCAL FAKE (test only)");
  };

  const server =
    o.mode === "implicit"
      ? tls.createServer({ key: KEY, cert: FAKE_SMTP_CERT }, (s) => session(s, true))
      : net.createServer((s) => session(s, false));
  await new Promise<void>((r) => server.listen(0, "localhost", r));
  state.port = (server.address() as net.AddressInfo).port;
  state.close = () => new Promise<void>((r) => server.close(() => r()));
  return state;
}

export interface FakeHttpRequest {
  path: string;
  headers: http.IncomingHttpHeaders;
  body: any;
}

/** answer(req, n) → [status, json body, extra headers]; n counts requests from 1. */
export async function fakeHttpProvider(
  answer: (req: FakeHttpRequest, n: number) => [number, unknown, Record<string, string>?],
) {
  const requests: FakeHttpRequest[] = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const r = { path: req.url ?? "", headers: req.headers, body: raw ? JSON.parse(raw) : null };
      requests.push(r);
      const [status, body, headers] = answer(r, requests.length);
      res.writeHead(status, { "Content-Type": "application/json", ...headers });
      res.end(JSON.stringify(body));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as net.AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}
