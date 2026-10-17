import sharp from "sharp";
/*
 * A test agency: an Agent / Host organisation (AGENCY-PRO, active) with a manager, two leasing agents, an
 * accountant, a finance director, an auditor and a viewer, plus helpers to draft a listing with a photo and get it
 * published by PALTAS staff.
 */
import { createHash, randomBytes } from "node:crypto";
import type { agency } from "@paltas/contracts";
import { agencyProduct } from "../../dist/products/agency/index.js";
import type { Config } from "../../dist/config.js";
import { startServer, type Person, type TestServer } from "./test-server.js";

export function startAgencyServer(config: Partial<Config> = {}): Promise<TestServer> {
  return startServer({
    products: [agencyProduct()],
    config: {
      marketplace: { searchPerMinute: 10_000, submitPerHour: 10_000 },
      logLevel: process.env.AGENCY_LOG ?? "silent",
      ...config,
    },
  });
}

export interface AgencyOrg {
  orgId: string;
  admin: Person;
  manager: Person;
  agent: Person;
  agent2: Person;
  accountant: Person;
  fd: Person;
  auditor: Person;
  viewer: Person;
}

export async function agencyOrg(S: TestServer, name?: string): Promise<AgencyOrg> {
  const o = await S.newOrg({
    name: name ?? "Prime Realty " + randomBytes(3).toString("hex"),
    product: "agency",
    plan: "AGENCY-PRO",
    trial: false,
  });
  const add = (role: Parameters<TestServer["addMember"]>[2]) => S.addMember(o.orgId, o.admin.api, role);
  return {
    orgId: o.orgId,
    admin: o.admin,
    manager: await add("property_manager"),
    agent: await add("leasing_agent"),
    agent2: await add("leasing_agent"),
    accountant: await add("accountant"),
    fd: await add("finance_director"),
    auditor: await add("auditor"),
    viewer: await add("viewer"),
  };
}

export const sha = (s: string) => createHash("sha256").update(s).digest("hex");

type ListingBody = NonNullable<Parameters<Person["api"]["agency"]["createListing"]>[0]>["body"];

export const SALE: ListingBody = {
  purpose: "sale",
  propertyType: "Apartment",
  title: "Oceanview Apartment in Nyali",
  description: "Three bedrooms, sea view, secure parking and a pool in a quiet compound.",
  country: "Kenya",
  city: "Mombasa",
  area: "Nyali",
  addressPrivate: "Plot 77, Links Road — gate code 4411",
  bedrooms: 3,
  bathrooms: 2,
  sizeM2: 120,
  amenities: ["pool", "parking"],
  priceMinor: 1_850_000_000,
};

export const STAY: ListingBody = {
  purpose: "stay",
  propertyType: "Villa",
  title: "Diani Beach Villa",
  description: "A beachfront villa with a pool, four bedrooms and a full kitchen, ten minutes from the shops.",
  country: "Kenya",
  city: "Diani",
  area: "Galu",
  addressPrivate: "Galu Beach Road, villa 9",
  bedrooms: 4,
  bathrooms: 4,
  maxGuests: 8,
  amenities: ["pool", "beach", "wifi"],
  priceMinor: 2_000_000, // KES 20,000 a night
  cleaningFeeMinor: 300_000,
  serviceFeePct: 8,
  taxPct: 5,
  minNights: 2,
};

export async function photoBody() {
  const content = await sharp({ create: { width: 4, height: 4, channels: 3, background: "#118866" } })
    .png()
    .toBuffer();
  return { fileName: "front.png", contentBase64: content.toString("base64") };
}

/** Draft a listing with one photo, submit it, and have PALTAS staff publish it. */
export async function publishedListing(
  S: TestServer,
  orgId: string,
  manager: Person,
  body: ListingBody,
): Promise<agency.Listing> {
  const api = manager.api.agency;
  const l = await api.createListing({ params: { orgId }, body });
  await api.uploadPhoto({ params: { orgId, listingId: l.id }, body: await photoBody() });
  await api.submitListing({ params: { orgId, listingId: l.id } });
  const staff = await S.staff();
  await staff.api.marketplace.approveListing({ params: { listingId: l.id }, body: { note: "Checked" } });
  return api.getListing({ params: { orgId, listingId: l.id } });
}

/** A client (seller, landlord or stay owner) in the organisation's ONE contact store. */
export async function client(p: Person, orgId: string, person: { name: string; email?: string; phone?: string }) {
  const r = await p.api.contacts.createContact({ params: { orgId }, body: { ...person, types: ["owner"] } });
  return r.contact;
}

/** Debit minus credit of one account in the organisation's trial balance. */
export async function ledgerBalance(S: TestServer, orgId: string, code: string): Promise<number> {
  const [r] = await S.sql<{ n: number }>(
    `SELECT COALESCE(sum(l.debit_minor - l.credit_minor), 0)::bigint AS n FROM journal_lines l
     JOIN journal_entries e ON e.id = l.entry_id AND e.status = 'posted' WHERE l.org_id = $1 AND l.account_code = $2`,
    [orgId, code],
  );
  return Number(r?.n ?? 0);
}
