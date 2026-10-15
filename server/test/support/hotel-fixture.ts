/*
 * A test hotel: a hotel organisation (HOTEL-PRO, active), its staff in every hotel role, and a property with 30 rooms
 * in 3 types, 2 rate plans, 1 channel (via the sandbox channel manager), a restaurant and a spa, and a company
 * account. Taxes: VAT 16 %, service charge 10 % on F&B and spa, tourism levy 2 % of room revenue.
 */
import { randomBytes } from "node:crypto";
import type { Role } from "@paltas/contracts";
import { signPayload } from "../../dist/core/payments/signature.js";
import { hotelProduct } from "../../dist/products/hotel/index.js";
import { startServer, WEBHOOK_SECRET, type Person, type TestServer } from "./test-server.js";

export const CHANNEL_PROVIDER = "sandboxchannel";
export const CHANNEL_SECRET = "whsec_channel_" + randomBytes(16).toString("hex");

export async function startHotelServer(): Promise<TestServer> {
  return startServer({
    products: [hotelProduct()],
    config: { webhookSecrets: { testpay: WEBHOOK_SECRET, [CHANNEL_PROVIDER]: CHANNEL_SECRET } },
  });
}

export const STAFF_ROLES = [
  "general_manager",
  "front_office_manager",
  "receptionist",
  "revenue_manager",
  "housekeeping_supervisor",
  "housekeeping_attendant",
  "outlet_staff",
  "financial_controller",
  "income_auditor",
  "credit_controller",
  "technician",
  "auditor",
  "group_owner",
] as const satisfies readonly Role[];

export type Staff = Record<(typeof STAFF_ROLES)[number], Person>;

export const TAX = {
  vatPct: 16,
  serviceChargePct: 10,
  serviceChargeDepartments: ["fnb", "spa"] as ("fnb" | "spa")[],
  vatOnServiceCharge: true,
  levy: { kind: "percent_of_room" as const, name: "Tourism levy", amountMinor: 0, pct: 2 },
};

export async function hotelOrg(S: TestServer, name?: string) {
  const o = await S.newOrg({
    name: name ?? "Hotel Group " + randomBytes(3).toString("hex"),
    product: "hotel",
    plan: "HOTEL-PRO",
    trial: false,
  });
  const staff = {} as Staff;
  for (const r of STAFF_ROLES) staff[r] = await S.addMember(o.orgId, o.admin.api, r);
  return { orgId: o.orgId, admin: o.admin, staff };
}

export interface TestHotel {
  propertyId: string;
  types: { STD: string; DLX: string; STE: string };
  rooms: Record<string, { id: string; number: string; roomTypeId: string }>;
  plans: { BAR: string; NRF: string };
  channelId: string;
  outlets: { restaurant: string; spa: string };
  companyId: string;
}

/** Rates (KES minor units): BAR 10,000 / 15,000 / 30,000; NRF 9,000 / 13,500 / 27,000. */
export const BAR = { STD: 1_000_000, DLX: 1_500_000, STE: 3_000_000 };
export const NRF = { STD: 900_000, DLX: 1_350_000, STE: 2_700_000 };

export async function buildHotel(
  orgId: string,
  gm: Person,
  o: {
    name?: string;
    counts?: { STD: number; DLX: number; STE: number };
    faq?: { question: string; keywords: string[]; answer: string }[];
    restaurantStaff?: string[];
    /** Members assigned to work at the hotel (non-admin staff reach only the hotels they are assigned to). */
    staff?: Partial<Staff>;
  } = {},
): Promise<TestHotel> {
  const api = gm.api.hotel;
  const counts = o.counts ?? { STD: 15, DLX: 10, STE: 5 };
  const p = await api.createProperty({
    params: { orgId },
    body: {
      name: o.name ?? "Kilima Beach Hotel",
      country: "Kenya",
      city: "Mombasa",
      timezone: "Africa/Nairobi",
      tax: TAX,
      faq: o.faq ?? [
        {
          question: "What is the Wi-Fi password?",
          keywords: ["wifi", "wi-fi", "internet"],
          answer: "Network KILIMA-GUEST, password beach2026.",
        },
        {
          question: "When is breakfast?",
          keywords: ["breakfast"],
          answer: "Breakfast is served 06:30–10:30 in the Ocean Restaurant.",
        },
      ],
    },
  });
  const P = { orgId, propertyId: p.id };
  if (o.staff)
    await api.setPropertyStaff({
      params: P,
      body: { userIds: [gm.userId, ...Object.values(o.staff).map((m) => m.userId)] },
    });
  const types = {} as TestHotel["types"];
  for (const [code, name, adults] of [
    ["STD", "Standard", 2],
    ["DLX", "Deluxe sea view", 3],
    ["STE", "Suite", 4],
  ] as const) {
    types[code] = (
      await api.createRoomType({ params: P, body: { code, name, capacityAdults: adults, beds: "1 king" } })
    ).id;
  }
  const list: { number: string; roomTypeId: string; floor: string }[] = [];
  let n = 100;
  for (const code of ["STD", "DLX", "STE"] as const)
    for (let i = 0; i < counts[code]; i++)
      list.push({ number: String(++n), roomTypeId: types[code], floor: String(Math.floor(n / 100)) });
  const created = await api.createRooms({ params: P, body: { rooms: list } });
  const rooms: TestHotel["rooms"] = {};
  for (const r of created.rooms) rooms[r.number] = { id: r.id, number: r.number, roomTypeId: r.roomTypeId };
  const bar = await api.createRatePlan({
    params: P,
    body: {
      code: "BAR",
      name: "Best available rate",
      kind: "bar",
      policy: { refundable: true, freeCancelDays: 2, cancelFeeNights: 1, noShowFeeNights: 1 },
      baseRates: (["STD", "DLX", "STE"] as const).map((c) => ({ roomTypeId: types[c], amountMinor: BAR[c] })),
    },
  });
  const nrf = await api.createRatePlan({
    params: P,
    body: {
      code: "NRF",
      name: "Non-refundable",
      kind: "non_refundable",
      policy: { refundable: false, freeCancelDays: 0, cancelFeeNights: 0, noShowFeeNights: 0 },
      baseRates: (["STD", "DLX", "STE"] as const).map((c) => ({ roomTypeId: types[c], amountMinor: NRF[c] })),
    },
  });
  const channel = await api.createChannel({
    params: P,
    body: { code: "BKG", name: "Booking site (OTA)", provider: CHANNEL_PROVIDER, commissionPct: 15 },
  });
  const restaurant = await api.createOutlet({
    params: P,
    body: { code: "REST", name: "Ocean Restaurant", department: "fnb", staffUserIds: o.restaurantStaff ?? [] },
  });
  const spa = await api.createOutlet({ params: P, body: { code: "SPA", name: "Reef Spa", department: "spa" } });
  const company = await api.listCorporateAccounts({ params: { orgId } });
  const existing = company.accounts.find((a) => a.name === "Safari Logistics Ltd");
  const companyId =
    existing?.id ??
    (
      await api.createCorporateAccount({
        params: { orgId },
        body: { name: "Safari Logistics Ltd", kind: "company", creditLimitMinor: 50_000_000 },
      })
    ).id;
  return {
    propertyId: p.id,
    types,
    rooms,
    plans: { BAR: bar.id, NRF: nrf.id },
    channelId: channel.id,
    outlets: { restaurant: restaurant.id, spa: spa.id },
    companyId,
  };
}

/** Deliver a signed channel-manager booking. */
export async function channelBooking(
  S: TestServer,
  body: Record<string, unknown>,
  opts: { provider?: string; secret?: string } = {},
) {
  const raw = JSON.stringify(body);
  const sig = signPayload(opts.secret ?? CHANNEL_SECRET, raw, Math.floor(Date.now() / 1000));
  return S.raw("POST", `/api/v1/webhooks/hotel/channels/${opts.provider ?? CHANNEL_PROVIDER}`, raw, null, {
    "X-Paltas-Signature": sig,
  });
}

export const guest = (name: string, extra: Record<string, string> = {}) => ({
  name,
  email: `${name.toLowerCase().replace(/[^a-z]+/g, ".")}@guest.test`,
  ...extra,
});
