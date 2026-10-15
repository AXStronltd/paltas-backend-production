/*
 * Typed client for the PALTAS API. Every method is generated from the endpoint definitions in @paltas/contracts,
 * so the front end calls exactly what the server serves: same paths, same inputs, same response shapes.
 *
 *   const api = createClient({ baseUrl: "https://api.example.com" });
 *   const { token } = await api.identity.login({ body: { email, password } });
 *   api.setToken(token);
 *   const tb = await api.ledger.trialBalance({ params: { orgId }, query: { asOf: "2026-10-31" } });
 */
import {
  API,
  ApiErrorBody,
  buildPath,
  type BodyOf,
  type EndpointDefinition,
  type ErrorCode,
  type ParamsOf,
  type QueryOf,
  type ResponseOf,
} from "@paltas/contracts";

/** Thrown for any non-2xx answer. `code` is the stable error code from the contracts. */
export class PaltasApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode | "NETWORK_ERROR" | "INVALID_RESPONSE",
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "PaltasApiError";
  }
}

export interface ClientOptions {
  /** Where the API runs, e.g. "http://localhost:8787". */
  baseUrl: string;
  /** Bearer token from login (can also be set later with setToken). */
  token?: string | null;
  /** Check every response against its contract (recommended in development and tests). */
  validateResponses?: boolean;
  /** Custom fetch (tests, server-side rendering). */
  fetch?: typeof fetch;
  /** Extra headers on every request. */
  headers?: Record<string, string>;
}

type EmptyObject = Record<string, never>;
/** An empty object schema infers as Record<string, never> in zod 4, so "no keys" and "only an index signature" both count. */
type IsEmpty<T> = [keyof T] extends [never] ? true : string extends keyof T ? true : false;

/** What a call needs: params when the path has them, a body when the endpoint takes one, an optional query. */
export type CallInput<E> = (IsEmpty<ParamsOf<E>> extends true ? { params?: EmptyObject } : { params: ParamsOf<E> }) &
  (IsEmpty<QueryOf<E>> extends true ? { query?: EmptyObject } : { query?: QueryOf<E> }) &
  (BodyOf<E> extends undefined ? { body?: undefined } : { body: BodyOf<E> });

type GroupMethods<G> = {
  [K in keyof G]: (input?: CallInput<G[K]>) => Promise<ResponseOf<G[K]>>;
};

export type PaltasClient = { [G in keyof typeof API]: GroupMethods<(typeof API)[G]> } & {
  /** Call any endpoint definition directly. */
  call<E extends EndpointDefinition>(endpoint: E, input?: CallInput<E>): Promise<ResponseOf<E>>;
  setToken(token: string | null): void;
};

export function createClient(options: ClientOptions): PaltasClient {
  let token = options.token ?? null;
  const doFetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  const base = options.baseUrl.replace(/\/+$/, "");

  async function call<E extends EndpointDefinition>(endpoint: E, input?: CallInput<E>): Promise<ResponseOf<E>> {
    const i = (input ?? {}) as { params?: Record<string, string>; query?: Record<string, unknown>; body?: unknown };
    let url = base + buildPath(endpoint.path, i.params ?? {});
    const q = Object.entries(i.query ?? {}).filter(([, v]) => v !== undefined && v !== null);
    if (q.length) url += "?" + new URLSearchParams(q.map(([k, v]) => [k, String(v)])).toString();

    const headers: Record<string, string> = { Accept: "application/json", ...options.headers };
    if (token) headers.Authorization = "Bearer " + token;
    const hasBody = i.body !== undefined;
    if (hasBody) headers["Content-Type"] = "application/json";

    let res: Response;
    try {
      res = await doFetch(url, {
        method: endpoint.method,
        headers,
        body: hasBody ? JSON.stringify(i.body) : undefined,
      });
    } catch (e) {
      throw new PaltasApiError(0, "NETWORK_ERROR", "Could not reach the PALTAS server: " + (e as Error).message);
    }
    const text = await res.text();
    let data: unknown;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      throw new PaltasApiError(res.status, "INVALID_RESPONSE", "The server answered with something that is not JSON");
    }
    if (!res.ok) {
      const parsed = ApiErrorBody.safeParse(data);
      if (parsed.success) {
        const { code, message, details } = parsed.data.error;
        throw new PaltasApiError(res.status, code, message, details);
      }
      throw new PaltasApiError(res.status, "INVALID_RESPONSE", `Request failed with HTTP ${res.status}`);
    }
    if (options.validateResponses) {
      const checked = endpoint.response.safeParse(data);
      if (!checked.success) {
        throw new PaltasApiError(
          res.status,
          "INVALID_RESPONSE",
          `Response to ${endpoint.id} does not match its contract`,
          checked.error.issues,
        );
      }
      return checked.data as ResponseOf<E>;
    }
    return data as ResponseOf<E>;
  }

  const client: Record<string, unknown> = {
    call,
    setToken(t: string | null) {
      token = t;
    },
  };
  for (const [group, endpoints] of Object.entries(API)) {
    client[group] = Object.fromEntries(
      Object.entries(endpoints).map(([name, ep]) => [
        name,
        (input?: unknown) => call(ep as EndpointDefinition, input as never),
      ]),
    );
  }
  return client as PaltasClient;
}
