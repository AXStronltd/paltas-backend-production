/* ======================================================================
 * "CONFIGURED" AND "ANSWERING" ARE DIFFERENT QUESTIONS.
 *
 * Every integration in this service could already say whether its keys
 * were present. None could say whether the service replied — so an expired
 * key, a suspended account and a moved endpoint all looked exactly like a
 * working integration, and the first anybody knew was a customer saying
 * their tenants never got the rent reminder.
 *
 * These tests are mostly about the DISTINCTIONS, because the distinctions
 * are the whole point:
 *
 *   absent      nobody configured it — a choice, not a fault
 *   configured  settings present, nothing asked of it
 *   answering   asked, and it replied
 *   failing     configured, and it did not
 *
 * The one that must never be wrong is the last: it is the state that was
 * invisible, and reporting it as anything else puts it back.
 * ====================================================================== */

import test from "node:test";
import assert from "node:assert/strict";

process.env.SESSION_SECRET ||= "test-secret";
process.env.GOOGLE_CLIENT_ID ||= "test-client.apps.googleusercontent.com";
process.env.GOOGLE_CLIENT_SECRET ||= "test-client-secret";
process.env.PUBLIC_URL ||= "http://127.0.0.1:8080";
process.env.APP_URL ||= "http://127.0.0.1:8899";

const { integrationsReport, forgetIntegrationCache } =
  await import("../src/domain/integrations.ts");

/** A fetch that answers however a test wants, and counts what was asked. */
function fetcher(reply: (url: string) => Promise<Response> | Response) {
  const asked: string[] = [];
  const impl = (async (input: string | URL | Request) => {
    asked.push(String(input));
    return reply(String(input));
  }) as unknown as typeof globalThis.fetch;
  return { impl, asked };
}

const ok = () => new Response("{}", { status: 200 });
const state = (r: Awaited<ReturnType<typeof integrationsReport>>, key: string) => {
  const found = r.integrations.find((i) => i.key === key);
  assert.ok(found, `${key} is not in the registry`);
  return found;
};

test("without probing, nothing claims to be working", async () => {
  forgetIntegrationCache();
  const { impl, asked } = fetcher(ok);
  const r = await integrationsReport({ probe: false, fetchImpl: impl });

  assert.equal(asked.length, 0,
    "*** a report that was not asked to probe made outbound calls. A screen " +
    "reading this on every render would become a load test on somebody " +
    "else's API. ***");

  assert.ok(r.integrations.length >= 5, "the registry is nearly empty");
  assert.ok(r.integrations.every((i) => i.reach !== "answering"),
    "*** something claimed to be answering without being asked. That claim is " +
    "the one that made a dead integration invisible. ***");
  assert.deepEqual([...r.failing], [],
    "nothing can be failing when nothing was asked");
});

test("every integration says what stops working without it", async () => {
  forgetIntegrationCache();
  const r = await integrationsReport({ probe: false });
  for (const i of r.integrations) {
    assert.ok(i.carries.length > 20,
      `${i.key} does not say what it carries — "it is down" is not actionable ` +
      `unless somebody knows what that costs`);
    assert.ok(i.name && i.key, `${i.key} has no name`);
  }
});

test("absent is not failing", async () => {
  forgetIntegrationCache();
  /* Nothing in the test environment configures a channel manager. */
  const r = await integrationsReport({ probe: true, fetchImpl: fetcher(ok).impl });
  const ch = state(r, "channels");
  assert.equal(ch.reach, "absent");
  assert.ok(!r.failing.includes("channels"),
    "*** an integration nobody bought was reported as failing. A company that " +
    "does not sell through OTAs would see a red light for ever, which teaches " +
    "everybody to ignore this screen. ***");
  assert.equal(ch.optional, true, "a channel manager is not required to run a company");
});

test("a configured integration that does not answer is reported as failing", async () => {
  forgetIntegrationCache();
  const { impl } = fetcher(() => new Response("no", { status: 503 }));
  const r = await integrationsReport({ probe: true, fetchImpl: impl });

  const g = state(r, "google");
  assert.equal(g.reach, "failing",
    "*** a service that answered 503 was not reported as failing. This is the " +
    "exact state that used to be invisible. ***");
  assert.match(g.why, /did not answer/i);
  assert.match(g.why, /503/, "the provider's own status is what sends somebody to the cause");
  assert.ok(r.failing.includes("google"));
});

test("a probe that hangs is a failure, not a hung endpoint", async () => {
  forgetIntegrationCache();
  /* Never resolves. The timeout inside the module is what has to save this. */
  const { impl } = fetcher(() => new Promise<Response>(() => {}));
  const started = Date.now();
  const r = await integrationsReport({ probe: true, fetchImpl: impl });
  const took = Date.now() - started;

  assert.equal(state(r, "google").reach, "failing");
  assert.match(state(r, "google").why, /within/i, "it should say it waited and gave up");
  assert.ok(took < 20_000,
    `the report took ${took}ms against a supplier that never replies — a screen ` +
    `for diagnosing an outage must not become part of one`);
});

test("a service that answers is reported as answering, with how long it took", async () => {
  forgetIntegrationCache();
  const { impl } = fetcher(ok);
  const r = await integrationsReport({ probe: true, fetchImpl: impl });
  const g = state(r, "google");
  assert.equal(g.reach, "answering");
  assert.equal(typeof g.tookMs, "number", "how long it took is worth knowing");
  assert.deepEqual([...r.failing], [], "nothing failed");
});

test("probing twice in a minute asks once", async () => {
  forgetIntegrationCache();
  const first = fetcher(ok);
  await integrationsReport({ probe: true, fetchImpl: first.impl });
  assert.ok(first.asked.length > 0, "the first probe asked nothing");

  const second = fetcher(ok);
  const again = await integrationsReport({ probe: true, fetchImpl: second.impl });
  assert.equal(second.asked.length, 0,
    "*** a second check within the minute made the calls again. Eight outbound " +
    "requests per refresh is how you get rate-limited BY the services you are " +
    "checking, which then show as broken. ***");
  assert.equal(again.fresh, false, "a cached answer must say it is cached");
});

test("the cache can be cleared, because somebody fixing a key needs to re-ask", async () => {
  forgetIntegrationCache();
  const a = fetcher(ok);
  await integrationsReport({ probe: true, fetchImpl: a.impl });
  forgetIntegrationCache();
  const b = fetcher(ok);
  const r = await integrationsReport({ probe: true, fetchImpl: b.impl });
  assert.ok(b.asked.length > 0, "clearing the cache did not make it ask again");
  assert.equal(r.fresh, true);
});

test("a probe asks for nothing that costs money", async () => {
  forgetIntegrationCache();
  const { impl, asked } = fetcher(ok);
  await integrationsReport({ probe: true, fetchImpl: impl });

  /* Read-only, and no search or booking path — StayingAPI bills per result
     on a live key, and a status screen must never spend a customer's credit. */
  for (const url of asked) {
    assert.doesNotMatch(url, /\/(book|reserve|charge|search|prebook)/i,
      `a probe asked ${url}, which is not free and not read-only`);
  }
  assert.ok(asked.every((u) => u.startsWith("https://")),
    "a probe left the https path");
});
