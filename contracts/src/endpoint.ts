/*
 * An endpoint definition is the agreement between the server and the front end for one API call:
 * method, path, who may call it, and the exact shape of params, query, body and response.
 *
 * The server registers its handler FROM this definition (server/src/http/route.ts), validating every request and
 * response against it. The front-end client calls it FROM the same definition (api-client). If either side drifts,
 * TypeScript fails the build.
 */
import { z } from "zod";

export type HttpMethod = "GET" | "POST" | "PUT" | "DELETE";

/**
 * - "public": anyone (health).
 * - "user": a signed-in person (any role checks happen in the handler via capabilities).
 * - "staff": PALTAS staff signed in with their second factor.
 * - "signed-webhook": a payment provider, proven by an HMAC signature header.
 */
export type EndpointAuth = "public" | "user" | "staff" | "signed-webhook";

type AnyObject = z.ZodType<Record<string, unknown>>;

export interface EndpointDefinition<
  P extends AnyObject = AnyObject,
  Q extends AnyObject = AnyObject,
  B extends z.ZodType = z.ZodType,
  R extends z.ZodType = z.ZodType,
  A extends EndpointAuth = EndpointAuth,
> {
  /** Stable name, "area.action", used in logs, docs and the client. */
  id: string;
  method: HttpMethod;
  /** Express-style path; ":name" segments are params. */
  path: string;
  auth: A;
  summary: string;
  params: P;
  query: Q;
  body: B;
  response: R;
  /** HTTP status on success (default 200). */
  status: 200 | 201;
}

const NoParams = z.object({});
const NoQuery = z.object({});
const NoBody = z.undefined().optional();

/** Define an endpoint. Omitted parts default to "none". */
export function endpoint<
  A extends EndpointAuth,
  P extends AnyObject = typeof NoParams,
  Q extends AnyObject = typeof NoQuery,
  B extends z.ZodType = typeof NoBody,
  R extends z.ZodType = z.ZodType,
>(def: {
  id: string;
  method: HttpMethod;
  path: string;
  auth: A;
  summary: string;
  params?: P;
  query?: Q;
  body?: B;
  response: R;
  status?: 200 | 201;
}): EndpointDefinition<P, Q, B, R, A> {
  return {
    ...def,
    params: (def.params ?? NoParams) as P,
    query: (def.query ?? NoQuery) as Q,
    body: (def.body ?? NoBody) as unknown as B,
    status: def.status ?? 200,
  };
}

export type ParamsOf<E> = E extends EndpointDefinition<infer P, AnyObject, z.ZodType, z.ZodType> ? z.infer<P> : never;
export type QueryOf<E> = E extends EndpointDefinition<AnyObject, infer Q, z.ZodType, z.ZodType> ? z.input<Q> : never;
export type BodyOf<E> = E extends EndpointDefinition<AnyObject, AnyObject, infer B, z.ZodType> ? z.input<B> : never;
export type ResponseOf<E> = E extends EndpointDefinition<AnyObject, AnyObject, z.ZodType, infer R> ? z.infer<R> : never;

/** Fill ":name" path segments from params (URL-encoded). */
export function buildPath(path: string, params: Record<string, string | number>): string {
  return path.replace(/:([A-Za-z_]+)/g, (_, k: string) => {
    const v = params[k];
    if (v === undefined) throw new Error(`Missing path parameter "${k}" for ${path}`);
    return encodeURIComponent(String(v));
  });
}
