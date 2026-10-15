/*
 * Integration boundaries. PALTAS talks to security hardware and outside services only through these interfaces.
 * No certified adapter is installed yet, so each one is a TEST adapter that says so: no door is unlocked, no credential
 * is enrolled on a reader, no CCTV clip is fetched, no fingerprint or face is verified, no SMS / WhatsApp / push is
 * delivered, no invoice is submitted to the tax authority and no salary is paid out.
 * Alarm panels and panic buttons reach PALTAS through the signed webhook (POST /api/v1/webhooks/security/alarms/:provider),
 * with the provider's secret in WEBHOOK_SECRET_<PROVIDER>; the test suite signs with a test secret.
 */
import type { security, z } from "@paltas/contracts";

export type IntegrationState = z.infer<typeof security.IntegrationState>;

const TEST: IntegrationState = { adapter: "sandbox", connected: false, status: "Not connected — test adapter" };

/** Door controllers and readers. */
export interface AccessControlAdapter {
  state: IntegrationState;
  /** Enrol a credential on the readers of its groups' doors. Returns the status kept with the credential. */
  enrol(credential: { id: string; kind: string; doorCodes: string[] }): string;
  revoke(credentialId: string): string;
  /** Unlock a door now. A test adapter never unlocks anything. */
  unlock(door: { code: string }): { done: boolean; status: string };
}

/** Guard app pushes, SMS and WhatsApp. */
export interface MessagingAdapter {
  state: IntegrationState;
  deliver(message: { to: string; text: string }): string;
}

/** Fingerprint / face readers used at clock-in. */
export interface BiometricAdapter {
  state: IntegrationState;
  verify(evidence: { method: string; deviceRef: string | null }): { verified: boolean; status: string };
}

export interface SecurityAdapters {
  accessControl: AccessControlAdapter;
  messaging: MessagingAdapter;
  biometrics: BiometricAdapter;
  /** Video clips are kept as references given by the user; nothing is fetched from a CCTV system. */
  cctv: { state: IntegrationState };
  /** Alarm panels deliver through the signed webhook; this states whether a certified provider is configured. */
  alarmMonitoring: { state: IntegrationState };
  taxAuthority: { state: IntegrationState; submitInvoice(number: string): string };
  payrollPayout: { state: IntegrationState; payout(period: string): string };
}

export const sandboxAdapters: SecurityAdapters = {
  accessControl: {
    state: TEST,
    enrol: () => "Not enrolled — no door controller connected (test adapter)",
    revoke: () => "Not sent to any reader — no door controller connected (test adapter)",
    unlock: () => ({
      done: false,
      status: "Refused — no door controller connected (test adapter); nothing was unlocked",
    }),
  },
  messaging: {
    state: TEST,
    deliver: () => "Recorded — not sent (no messaging provider connected)",
  },
  biometrics: {
    state: TEST,
    verify: (e) => ({
      verified: false,
      status:
        e.method === "biometric"
          ? "Recorded as submitted — no biometric reader connected (test adapter)"
          : "Recorded as submitted — position reported by the device, not independently verified",
    }),
  },
  cctv: { state: TEST },
  alarmMonitoring: { state: { adapter: "signed-webhook", connected: false, status: "Not connected — test adapter" } },
  taxAuthority: {
    state: TEST,
    submitInvoice: () => "Not submitted — no tax-authority connection (test adapter)",
  },
  payrollPayout: {
    state: TEST,
    payout: () => "Not paid out — no bank or mobile-money payout connection; pay outside PALTAS and record it",
  },
};
