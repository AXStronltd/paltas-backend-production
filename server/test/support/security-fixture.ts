/*
 * A test security company: an organisation on SEC-PRO (active), its staff in every security role (two guards with
 * their own app accounts), payroll rules, and one client site with a geofence, an alarm-monitoring account, two posts
 * with post orders, three patrol checkpoints and a contract. Times are East Africa Time (+03:00).
 */
import { randomBytes } from "node:crypto";
import type { Role } from "@paltas/contracts";
import { signPayload } from "../../dist/core/payments/signature.js";
import { securityProduct } from "../../dist/products/security/index.js";
import { startServer, WEBHOOK_SECRET, type Person, type TestServer } from "./test-server.js";

export const ALARM_PROVIDER = "sandboxalarm";
export const ALARM_SECRET = "whsec_alarm_" + randomBytes(16).toString("hex");

export async function startSecurityServer(): Promise<TestServer> {
  return startServer({
    products: [securityProduct()],
    config: { webhookSecrets: { testpay: WEBHOOK_SECRET, [ALARM_PROVIDER]: ALARM_SECRET } },
  });
}

export const SECURITY_ROLES = [
  "operations_manager",
  "supervisor",
  "control_room_operator",
  "gate_officer",
  "access_administrator",
  "accountant",
  "finance_director",
  "auditor",
  "security_client",
  "viewer",
] as const satisfies readonly Role[];

export type Staff = Record<(typeof SECURITY_ROLES)[number], Person> & { guardA: Person; guardB: Person };

export async function securityOrg(S: TestServer, name?: string) {
  const o = await S.newOrg({
    name: name ?? "Usalama Guards " + randomBytes(3).toString("hex"),
    product: "security",
    plan: "SEC-PRO",
    trial: false,
  });
  const staff = {} as Staff;
  for (const r of SECURITY_ROLES) staff[r] = await S.addMember(o.orgId, o.admin.api, r);
  staff.guardA = await S.addMember(o.orgId, o.admin.api, "guard");
  staff.guardB = await S.addMember(o.orgId, o.admin.api, "guard");
  return { orgId: o.orgId, admin: o.admin, staff };
}

/** Site centre (Westlands, Nairobi) and a point about 2 km away. */
export const SITE_POS = { lat: -1.2635, lng: 36.8045 };
export const FAR_POS = { lat: -1.2815, lng: 36.8045 };

/** Pay rates (KES minor units per hour) and rules. Configuration rows — the test's own, not PALTAS defaults. */
export const RULES = {
  payRates: [
    { grade: "Guard", hourlyMinor: 10_000, overtimePct: 150, holidayPct: 200 },
    { grade: "Supervisor", hourlyMinor: 16_000, overtimePct: 150, holidayPct: 200 },
  ],
  statutory: [
    {
      code: "PEN",
      label: "Pension fund",
      party: "employee" as const,
      pct: 6,
      minMinor: 0,
      baseCapMinor: null,
      reducesTaxablePay: true,
    },
    {
      code: "PEN",
      label: "Pension fund",
      party: "employer" as const,
      pct: 6,
      minMinor: 0,
      baseCapMinor: null,
      reducesTaxablePay: false,
    },
    {
      code: "HLT",
      label: "Health insurance",
      party: "employee" as const,
      pct: 2.75,
      minMinor: 30_000,
      baseCapMinor: null,
      reducesTaxablePay: false,
    },
  ],
  incomeTaxBands: [
    { widthMinor: 200_000, pct: 10 },
    { widthMinor: null, pct: 25 },
  ],
  personalReliefMinor: 2_000,
};

export interface TestOps {
  clientId: string;
  siteId: string;
  gatePostId: string;
  patrolPostId: string;
  contractId: string;
  checkpoints: { CP1: string; CP2: string; CP3: string };
  guards: { A: string; B: string };
}

export async function buildOps(
  orgId: string,
  st: Staff,
  o: { name?: string; accountRef?: string } = {},
): Promise<TestOps> {
  const ops = st.operations_manager.api.security;
  const P = { orgId };
  await st.finance_director.api.security.setPayrollRules({ params: P, body: RULES });
  const client = await ops.createClient({
    params: P,
    body: {
      name: (o.name ?? "Westgate Properties") + " Ltd",
      contactName: "Daniel Kariuki",
      email: "ap@westgate.example.com",
      paymentTermsDays: 30,
      whtPct: 3,
      vatWhtPct: 2,
      creditLimitMinor: 300_000_000,
    },
  });
  const site = await ops.createSite({
    params: P,
    body: {
      clientId: client.id,
      name: o.name ?? "Westlands Office Park",
      area: "Westlands",
      kind: "Office park",
      risk: "medium",
      geofence: { ...SITE_POS, radiusM: 250 },
      instructions: "Visitors after 22:00 need host approval by phone.",
      alarmMonitoring: { provider: ALARM_PROVIDER, accountRef: o.accountRef ?? "WST-001" },
    },
  });
  const gate = await ops.createPost({
    params: { orgId, siteId: site.id },
    body: { name: "Gate A", cover: "24h", guardsRequired: 1, orderText: "Check every vehicle. Log every visitor." },
  });
  const patrol = await ops.createPost({
    params: { orgId, siteId: site.id },
    body: { name: "Perimeter patrol", cover: "night", guardsRequired: 1 },
  });
  const cps = await ops.createCheckpoints({
    params: { orgId, siteId: site.id },
    body: {
      checkpoints: [
        { code: "CP1", name: "Gate A", tagRef: "NFC-0001", offsetMinutes: 0, graceMinutes: 5 },
        { code: "CP2", name: "Tower 1", tagRef: "NFC-0002", offsetMinutes: 15, graceMinutes: 5 },
        { code: "CP3", name: "Basement", tagRef: "NFC-0003", offsetMinutes: 30, graceMinutes: 5 },
      ],
    },
  });
  const contract = await ops.createContract({
    params: P,
    body: {
      clientId: client.id,
      siteId: site.id,
      startDate: "2026-09-01",
      monthlyFeeMinor: 118_000_000,
      extraHourRateMinor: 45_000,
      vatPct: 16,
      patrolTargetPct: 95,
      responseMinutes: 10,
    },
  });
  const guardA = await ops.createGuard({
    params: P,
    body: {
      name: "Amina Hassan",
      grade: "Guard",
      userId: st.guardA.userId,
      licenceNo: "PSRA-11223",
      licenceExpiry: "2027-06-30",
      vetting: "cleared",
      homeSiteId: site.id,
    },
  });
  const guardB = await ops.createGuard({
    params: P,
    body: {
      name: "Peter Kamau",
      grade: "Guard",
      userId: st.guardB.userId,
      licenceNo: "PSRA-44556",
      licenceExpiry: "2027-03-31",
      vetting: "cleared",
      homeSiteId: site.id,
    },
  });
  const by = (code: string) => cps.checkpoints.find((c) => c.code === code)!.id;
  return {
    clientId: client.id,
    siteId: site.id,
    gatePostId: gate.id,
    patrolPostId: patrol.id,
    contractId: contract.id,
    checkpoints: { CP1: by("CP1"), CP2: by("CP2"), CP3: by("CP3") },
    guards: { A: guardA.id, B: guardB.id },
  };
}

/**
 * October's worked shifts, approved: guard A 5 Oct day (05:55–18:30: 720 normal + 35 overtime) and 6 Oct day
 * (corrected to 06:30–18:00: 690); guard B 5 Oct night on patrol (720) and 7 Oct night extra cover (720, billable).
 * Pay at 100.00/h: A 243,750 minor, B 240,000 minor. Extra cover billed: 720 min × 450.00/h = 540,000 minor.
 */
export async function workOctober(orgId: string, st: Staff, ops: TestOps) {
  const sup = st.supervisor.api.security;
  const om = st.operations_manager.api.security;
  const P = { orgId };
  const mk = async (postId: string, startsAt: string, endsAt: string, extra = false) =>
    (await om.createShifts({ params: P, body: { postId, shifts: [{ startsAt, endsAt, extra }] } })).shifts[0]!.id;
  const a1 = await mk(ops.gatePostId, eat("2026-10-05", "06:00"), eat("2026-10-05", "18:00"));
  const a2 = await mk(ops.gatePostId, eat("2026-10-06", "06:00"), eat("2026-10-06", "18:00"));
  const b1 = await mk(ops.patrolPostId, eat("2026-10-05", "18:00"), eat("2026-10-06", "06:00"));
  const b2 = await mk(ops.gatePostId, eat("2026-10-07", "18:00"), eat("2026-10-08", "06:00"), true);
  for (const [id, g] of [
    [a1, ops.guards.A],
    [a2, ops.guards.A],
    [b1, ops.guards.B],
    [b2, ops.guards.B],
  ] as const)
    await om.assignShift({ params: { orgId, shiftId: id }, body: { guardId: g } });
  const gate = await om.getSite({ params: { orgId, siteId: ops.siteId } });
  const version = gate.posts.find((p) => p.id === ops.gatePostId)!.orderVersion;
  for (const [who, guardId] of [
    [st.guardA, ops.guards.A],
    [st.guardB, ops.guards.B],
  ] as const)
    await who.api.security.acknowledgePostOrder({
      params: { orgId, postId: ops.gatePostId },
      body: { guardId, version },
    });
  const ev = (at: string, pos = SITE_POS) => ({ capturedAt: at, method: "gps" as const, ...pos, accuracyM: 12 });
  const ga = st.guardA.api.security;
  const gb = st.guardB.api.security;
  await ga.clockIn({ params: { orgId, shiftId: a1 }, body: ev(eat("2026-10-05", "05:55")) });
  await ga.clockOut({ params: { orgId, shiftId: a1 }, body: ev(eat("2026-10-05", "18:30")) });
  await gb.clockIn({ params: { orgId, shiftId: b1 }, body: ev(eat("2026-10-05", "18:00"), FAR_POS) });
  await gb.clockOut({ params: { orgId, shiftId: b1 }, body: ev(eat("2026-10-06", "06:00")) });
  await gb.clockIn({ params: { orgId, shiftId: b2 }, body: ev(eat("2026-10-07", "18:00")) });
  await gb.clockOut({ params: { orgId, shiftId: b2 }, body: ev(eat("2026-10-08", "06:00")) });
  await sup.adjustAttendance({
    params: { orgId, shiftId: a2 },
    body: {
      inAt: eat("2026-10-06", "06:30"),
      outAt: eat("2026-10-06", "18:00"),
      reason: "Phone battery dead, supervisor saw her on post",
    },
  });
  await om.approveTimesheets({ params: P, body: { shiftIds: [a1, a2, b1, b2] } });
  return { a1, a2, b1, b2 };
}

/** East Africa Time moment, e.g. eat("2026-10-05", "06:00"). */
export const eat = (date: string, time: string) => `${date}T${time}:00+03:00`;

/** Deliver a signed alarm-provider event. */
export async function alarmEvent(
  S: TestServer,
  body: Record<string, unknown>,
  opts: { provider?: string; secret?: string } = {},
) {
  const raw = JSON.stringify(body);
  const sig = signPayload(opts.secret ?? ALARM_SECRET, raw, Math.floor(Date.now() / 1000));
  return S.raw("POST", `/api/v1/webhooks/security/alarms/${opts.provider ?? ALARM_PROVIDER}`, raw, null, {
    "X-Paltas-Signature": sig,
  });
}
