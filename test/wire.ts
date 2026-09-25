/* ====================================================================== *
 * WHAT A TEST GETS BACK FROM THE API.
 *
 * ── THE ONE `any` IN THIS REPOSITORY, AND WHY IT IS HERE ───────────────
 *
 * Everything else in this migration was typed without one. This is the
 * exception, it is deliberate, and it is in a single file so it can be
 * counted on one hand and argued with in one place.
 *
 * A response body is bytes off a socket, parsed by JSON.parse. It has not
 * been through the type system at either end: the service serialised it and
 * this process parsed it, and nothing in between carried a type. That is the
 * definition of an external boundary.
 *
 * ── WHAT THE ALTERNATIVES ACTUALLY COST ───────────────────────────────
 *
 * `unknown` is the principled answer and it is wrong here. Every one of the
 * ~700 assertions in this suite reads a path — `r.json.offer.contract.ref` —
 * and narrowing each would mean a guard per line, in code whose entire job
 * is to state a fact about a shape and fail loudly when it is not there.
 * The guards would not catch anything the assertion does not already catch,
 * and they would bury the assertion.
 *
 * A declared shape per endpoint is the other answer, and it is a real
 * project with real value — it would make the frontend contract checkable
 * from the types rather than from `contract.test.js` reading backend.md as
 * text. It is not this project, and doing it badly at speed would produce
 * ~350 hand-written interfaces that drift from the routes they describe:
 * the second source of truth this whole migration exists to remove.
 *
 * ── WHAT THIS DOES NOT WEAKEN ─────────────────────────────────────────
 *
 * Nothing in `src/` uses this. The service is typed end to end and knows
 * exactly what it builds. This says only that a TEST, having asked the
 * running service a question over HTTP, reads the answer as the JSON it is.
 * If the shape is wrong the assertion fails — which is the test doing its
 * job, and is why these files exist.
 * ====================================================================== */

/** A parsed JSON response body. See the note above before widening its use. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Wire = any;

/**
 * A VALUE BUILT BY CODE THIS REPOSITORY DOES NOT OWN.
 *
 * The same `any` and the same argument, for the other place it applies:
 * two suites load the FRONTEND's real scripts under a small DOM and read
 * what they attached to the window. That shape is declared in the other
 * repository — in JavaScript — and nothing here can know it.
 *
 * Named separately from `Wire` so a reader can tell at the call site which
 * boundary is being crossed: a response body, or somebody else's script.
 */
export type Foreign = Wire;

/**
 * One HTTP round trip, as this suite's `call()` helpers return it.
 *
 * `json` is null when the body was not JSON at all — a redirect has none,
 * and a test that asserts on the redirect reads `headers` instead.
 */
export interface Reply {
  readonly status: number;
  readonly json: Wire;
  readonly text: string;
  /* Optional because a handful of these helpers do not return it — the
     suites that assert on a redirect or a Set-Cookie do, and the rest read
     only the body. */
  readonly headers?: Headers;
}

/**
 * THE PORT A TEST SERVER ACTUALLY GOT.
 *
 * Every API suite here calls `.listen(0)` and reads the port back, because
 * a fixed port makes two suites collide on a busy machine. Node types
 * `address()` as `string | AddressInfo | null` — a string for a unix socket,
 * null before it is listening — and neither is true of a TCP server inside
 * a `before()` hook that already awaited "listening".
 *
 * Written once rather than narrowed twenty times, and it throws rather than
 * asserting: a server that is not listening here means the hook is wrong,
 * and that should say so at the hook rather than as a connection refused
 * forty lines later.
 */
export function portOf(server: import("node:http").Server): number {
  const at = server.address();
  if (at === null || typeof at === "string") {
    throw new Error("the test server is not listening on a TCP port");
  }
  return at.port;
}

/**
 * WHAT A TEST ASKS THE API FOR.
 *
 * Twenty-three suites each carry their own `call()` helper — near-identical,
 * and deliberately so: a shared one would have to grow a flag for every
 * difference between them, and each file states its own base URL and cookie
 * handling in the four lines where a reader is looking.
 *
 * What they DID share was an options bag written as a destructure with
 * defaults, which infers `{ method?: string }` from `{ method = "GET" }` and
 * rejects every other option. Naming it once is the whole fix.
 */
export interface CallOptions {
  readonly method?: string;
  /** Serialised as JSON. A GET carries none. */
  readonly body?: unknown;
  readonly cookie?: string;
  readonly headers?: Record<string, string>;
}

/**
 * A CAPABILITY THE THING UNDER TEST IS SUPPOSED TO HAVE.
 *
 * Several interfaces in this service declare optional methods, and correctly:
 * `describe()` on a supplier, `book()` on one that can sell, `prebook()` on
 * one that holds rates. Most adapters have some and none has all.
 *
 * A test that builds an adapter and then calls one of them is asserting it
 * is there. This says so — and if it is not, the failure names the method,
 * rather than being a TypeError inside somebody else's stack.
 */
export function has<T>(method: T | undefined, what: string): T {
  if (method === undefined || method === null) {
    throw new Error(`the adapter under test has no ${what}()`);
  }
  return method;
}

/**
 * A COMPLETE REPLY FROM A STUBBED `fetch`.
 *
 * The supplier suites inject fake responses to prove that an adapter handles
 * a refusal, a timeout or a malformed body. Each fake was an object literal
 * carrying the two or three members that adapter happened to read — which
 * meant a stub written for one adapter could not be handed to another, and
 * that a stub was quietly claiming to be something it was not.
 *
 * This builds a whole one. `text()` and `json()` agree with each other,
 * which is what a real response does and what a stub asserting on either
 * ought to do.
 */
export function reply(body: unknown, status = 200): import("../src/domain/supply.ts").FetchReply {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => text,
    json: async () => JSON.parse(text),
    headers: { get: () => null },
  };
}

/**
 * A VALUE THAT MUST BE THERE, ASSERTED AND NARROWED IN ONE LINE.
 *
 * `assert.ok(x)` is declared as an assertion in @types/node, but TypeScript
 * will not narrow through it: an assertion signature requires every name in
 * the call target to have an explicit type annotation, and `assert.ok` is a
 * property of a default import. So the assertion passes at runtime and the
 * compiler still believes the value may be null on the next line.
 *
 * Rather than a `!` after every such assert — which asserts rather than
 * checks, and would be a lie the day the assertion above it is deleted —
 * this does both, and its message is the one the test author wrote.
 */
export function present<T>(value: T | null | undefined, because: string): T {
  if (value === null || value === undefined) {
    throw new Error(because);
  }
  return value;
}
