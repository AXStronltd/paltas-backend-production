// Small helpers shared by the security services: percentages, distances, times and records every area loads.
import type { Db } from "../../../db/database.js";
import { fail } from "../../../http/errors.js";

/** A value the code has just written or checked; a missing one is a server error, not a user error. */
export function must<T>(v: T | null | undefined, what: string): T {
  if (v === null || v === undefined) throw new Error(`Expected ${what}`);
  return v;
}

export const toBp = (pct: number): number => Math.round(pct * 100);
export const fromBp = (bp: number): number => bp / 100;

/** amount × bp / 10 000, rounded half up, in integer arithmetic. */
export const shareOf = (amount: number, bp: number): number => Math.floor((amount * bp + 5000) / 10000);

/** Great-circle distance in metres. */
export function distanceM(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 6_371_000;
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(h)));
}

export const iso = (d: Date | string): string => new Date(d).toISOString();
export const minutesBetween = (a: string, b: string): number =>
  Math.round((new Date(b).getTime() - new Date(a).getTime()) / 60_000);
export const addMinutes = (a: string, m: number): string => new Date(new Date(a).getTime() + m * 60_000).toISOString();

/** Whole days from a to b ("YYYY-MM-DD"). */
export const daysBetween = (a: string, b: string): number =>
  Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / 86_400_000);

export async function orgTimezone(db: Db, orgId: string): Promise<string> {
  const o = await db.row<{ timezone: string }>("SELECT timezone FROM organisations WHERE id = $1", [orgId]);
  if (!o) throw fail.notFound("Organisation not found");
  return o.timezone;
}

export interface SiteRow {
  id: string;
  org_id: string;
  client_id: string | null;
  name: string;
  area: string;
  kind: string;
  risk: "low" | "medium" | "high";
  lat: number | null;
  lng: number | null;
  radius_m: number | null;
  instructions: string;
  alarm_provider: string | null;
  alarm_account_ref: string | null;
  active: boolean;
}

export async function findSite(db: Db, orgId: string, siteId: string): Promise<SiteRow> {
  const s = await db.row<SiteRow>("SELECT * FROM sec_sites WHERE org_id = $1 AND id = $2", [orgId, siteId]);
  if (!s) throw fail.notFound("Site not found");
  return s;
}

export interface ClientRow {
  id: string;
  org_id: string;
  number: string;
  name: string;
  contact_name: string;
  email: string | null;
  phone: string | null;
  payment_terms_days: number;
  wht_bp: number;
  vat_wht_bp: number;
  credit_limit_minor: number;
}

export async function findClient(db: Db, orgId: string, clientId: string): Promise<ClientRow> {
  const c = await db.row<ClientRow>("SELECT * FROM sec_clients WHERE org_id = $1 AND id = $2", [orgId, clientId]);
  if (!c) throw fail.notFound("Client not found");
  return c;
}

/** Is this user a member of the organisation? (Investigators, portal users.) */
export async function memberRole(db: Db, orgId: string, userId: string): Promise<string | null> {
  const m = await db.row<{ role: string }>(
    "SELECT role FROM memberships WHERE org_id = $1 AND user_id = $2 AND status = 'active'",
    [orgId, userId],
  );
  return m?.role ?? null;
}
