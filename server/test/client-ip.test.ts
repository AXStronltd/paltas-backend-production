// The client address behind every per-address limit cannot be chosen by the caller once Netlify signs its proxy:
// - only an HS256 token signed with the shared secret (and issued by Netlify) counts as signed;
// - a signed request is counted by the visitor address Netlify measured (x-nf-client-connection-ip);
// - anything else is counted by the address the load balancer saw (the rightmost X-Forwarded-For entry), so a forged
//   leftmost entry or a forged x-nf-client-connection-ip changes nothing;
// - without the secret the behaviour is unchanged.
import { createHmac } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { clientAddress, netlifySigned } from "../dist/http/client-ip.js";
import { signupBody, signupServer } from "./support/signup-fixture.js";
import type { TestServer } from "./support/test-server.js";

const SECRET = "s".repeat(24) + "-netlify-proxy-secret";
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
function token(
  claims: Record<string, unknown> = { iss: "netlify", site_url: "https://paltas.io" },
  secret = SECRET,
  alg = "HS256",
) {
  const head = b64({ alg, typ: "JWT" }),
    body = b64(claims);
  return `${head}.${body}.${createHmac("sha256", secret).update(`${head}.${body}`).digest("base64url")}`;
}

describe("Netlify signature", () => {
  it("accepts only an HS256 token signed with the shared secret and issued by Netlify", () => {
    expect(netlifySigned(token(), SECRET)).toBe(true);
    expect(netlifySigned(token(undefined, "another-secret-of-sufficient-length-x"), SECRET)).toBe(false);
    expect(netlifySigned(token(undefined, SECRET, "none"), SECRET)).toBe(false);
    expect(netlifySigned(token({ iss: "someone-else" }), SECRET)).toBe(false);
    expect(netlifySigned(token({ iss: "netlify", exp: 1 }), SECRET)).toBe(false);
    for (const bad of [undefined, "", "a.b", "x.y.z", "a".repeat(5000), 42])
      expect(netlifySigned(bad, SECRET)).toBe(false);
  });
  it("resolves the address from what the caller cannot write", () => {
    const forged = { "x-forwarded-for": "6.6.6.6, 203.0.113.9", "x-nf-client-connection-ip": "7.7.7.7" };
    expect(clientAddress(forged, SECRET)).toBe("203.0.113.9"); // unsigned: the load balancer's entry
    expect(clientAddress({ ...forged, "x-nf-sign": token() }, SECRET)).toBe("7.7.7.7"); // signed: Netlify's measurement
    expect(
      clientAddress({ ...forged, "x-nf-sign": token(undefined, "wrong-secret-wrong-secret-wrong!!") }, SECRET),
    ).toBe("203.0.113.9");
    expect(clientAddress({}, SECRET)).toBe("");
  });
});

describe("per-address limits behind the signed proxy", () => {
  let S: TestServer;
  beforeAll(async () => {
    S = await signupServer({ perIpPerHour: 2 }, { trustProxy: true, proxySigningSecret: SECRET });
  });
  afterAll(() => S.close());
  const ipOf = async (email: string) =>
    (await S.sql<{ ip: string }>("SELECT ip FROM org_signups WHERE email = lower($1)", [email]))[0]?.ip;

  it("a forged X-Forwarded-For no longer creates a fresh address; signed requests use Netlify's measurement", async () => {
    const send = (h: Record<string, string>) => {
      const b = signupBody("property");
      return S.raw("POST", "/api/v1/public/signup", b, null, h).then((r) => ({ r, email: b.email }));
    };
    // direct calls with a different forged first address each time: all counted as the load balancer's address
    const a = await send({ "x-forwarded-for": "1.1.1.1, 198.51.100.7" });
    const b = await send({ "x-forwarded-for": "2.2.2.2, 198.51.100.7" });
    const c = await send({ "x-forwarded-for": "3.3.3.3, 198.51.100.7" });
    expect([a.r.status, b.r.status, c.r.status]).toEqual([201, 201, 429]);
    expect(await ipOf(a.email)).toBe("198.51.100.7");
    // through the signed proxy: each visitor is counted on their own
    const d = await send({
      "x-forwarded-for": "9.9.9.9, 192.0.2.50",
      "x-nf-sign": token(),
      "x-nf-client-connection-ip": "203.0.113.20",
    });
    expect(d.r.status).toBe(201);
    expect(await ipOf(d.email)).toBe("203.0.113.20");
  });
});

describe("without the secret", () => {
  let S: TestServer;
  beforeAll(async () => {
    S = await signupServer({}, { trustProxy: true });
  });
  afterAll(() => S.close());
  it("nothing changes (the leftmost X-Forwarded-For entry, as before)", async () => {
    const b = signupBody("property");
    expect(
      (await S.raw("POST", "/api/v1/public/signup", b, null, { "x-forwarded-for": "203.0.113.77, 10.0.0.1" })).status,
    ).toBe(201);
    expect((await S.sql<{ ip: string }>("SELECT ip FROM org_signups WHERE email = lower($1)", [b.email]))[0]?.ip).toBe(
      "203.0.113.77",
    );
  });
});
