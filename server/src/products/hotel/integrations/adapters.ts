/*
 * Integration boundaries. PALTAS talks to external hotel systems only through these interfaces. No certified adapter
 * is installed yet, so every interface has a TEST adapter that records what would be sent and says so: nothing is
 * transmitted to a channel, no lock is programmed, no room control is switched and no message is delivered.
 * A real adapter replaces the test one here and reports connected: true.
 */
import type { hotel, z } from "@paltas/contracts";

export type IntegrationState = z.infer<typeof hotel.IntegrationState>;

const TEST: IntegrationState = { adapter: "sandbox", connected: false, status: "Not connected — test adapter" };

/** Channel manager: availability / rate updates out, bookings in (bookings arrive through the signed webhook). */
export interface ChannelManagerAdapter {
  state: IntegrationState;
  /** Queue an availability update. Returns the status stored with the message. */
  push(update: { channelId: string; roomTypeId: string; days: { date: string; available: number }[] }): string;
}

/** Door locks / mobile keys. */
export interface LockAdapter {
  state: IntegrationState;
  issue(key: { id: string; roomNumber: string; validFrom: string; validTo: string }): { ref: string };
  revoke(ref: string): void;
  /** Would this key open this room on this date? (A real lock decides this itself.) */
  opens(
    key: { status: "active" | "revoked"; roomId: string; validFrom: string; validTo: string },
    roomId: string,
    date: string,
  ): { opens: boolean; reason: string };
}

/** Room controls / energy management. */
export interface RoomControlAdapter {
  state: IntegrationState;
  send(command: {
    roomNumber: string;
    command: "eco_on" | "eco_off" | "set_temperature";
    value: number | null;
  }): string;
}

/** Guest messaging (WhatsApp, SMS, e-mail). */
export interface MessagingAdapter {
  state: IntegrationState;
  deliver(message: { channel: string; body: string }): string;
}

/** The tax authority's e-invoicing system (where a country requires it). */
export interface EInvoicingAdapter {
  state: IntegrationState;
  submit(invoice: { number: string; totalMinor: number }): { status: string; reference: string | null };
}

/** Kitchen order printers (the kitchen screen works without them). */
export interface KitchenPrinterAdapter {
  state: IntegrationState;
  print(ticket: { number: string; outletId: string }): string;
}

/** An external system PALTAS has a boundary for but does not call yet. */
export interface ExternalSystem {
  state: IntegrationState;
}

export interface HotelAdapters {
  channels: ChannelManagerAdapter;
  locks: LockAdapter;
  roomControls: RoomControlAdapter;
  messaging: MessagingAdapter;
  einvoicing: EInvoicingAdapter;
  kitchenPrinters: KitchenPrinterAdapter;
  /** Review-site invitations (TripAdvisor, Google …). */
  reviewSites: ExternalSystem;
  /** Exchange-rate feed (rates are entered by staff until one exists). */
  fxRates: ExternalSystem;
  /** Competitor rate shopping / market benchmark feed. */
  rateShopping: ExternalSystem;
  /** Country payroll engine: statutory deductions and net pay. */
  payrollEngine: ExternalSystem;
  /** Occupancy, energy, water and leak sensors. */
  sensors: ExternalSystem;
  /** A chain's own loyalty programme (PALTAS runs its own until connected). */
  chainLoyalty: ExternalSystem;
}

export const sandboxAdapters: HotelAdapters = {
  channels: {
    state: TEST,
    push: () => "Queued — not transmitted (channel manager not connected; test adapter)",
  },
  locks: {
    state: TEST,
    issue: (key) => ({ ref: `SANDBOX-KEY-${key.id.slice(-10)}` }),
    revoke: () => undefined,
    opens(key, roomId, date) {
      if (key.status !== "active") return { opens: false, reason: "Key revoked" };
      if (key.roomId !== roomId) return { opens: false, reason: "Key is for another room" };
      // valid from the arrival date until check-out time on the departure date
      if (date < key.validFrom || date > key.validTo) return { opens: false, reason: "Outside the stay dates" };
      return { opens: true, reason: "Valid for this room and date (test adapter decision)" };
    },
  },
  roomControls: {
    state: TEST,
    send: () => "Recorded — not sent (room-control system not connected; test adapter)",
  },
  messaging: {
    state: TEST,
    deliver: () => "Recorded — not sent (no messaging provider connected)",
  },
  einvoicing: {
    state: TEST,
    submit: () => ({ status: "Not submitted — e-invoicing not connected (test adapter)", reference: null }),
  },
  kitchenPrinters: {
    state: TEST,
    print: () => "On the kitchen screen only — kitchen printer not connected (test adapter)",
  },
  reviewSites: { state: TEST },
  fxRates: { state: { adapter: "manual", connected: false, status: "Not connected — rates entered by staff" } },
  rateShopping: { state: TEST },
  payrollEngine: { state: TEST },
  sensors: { state: TEST },
  chainLoyalty: { state: { adapter: "paltas", connected: false, status: "Not connected — PALTAS loyalty in use" } },
};
