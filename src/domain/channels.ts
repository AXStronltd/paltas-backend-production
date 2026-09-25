import { ExposableFailure } from "../http/errors.ts";

/* ====================================================================== *
 * PALTAS CONNECT — THE CHANNEL MANAGER SEAM.
 *
 * A channel is an OTA holding the same rooms this hotel is holding:
 * Booking.com, Expedia, Airbnb, a GDS. Connecting one means pushing rates and
 * availability out and pulling reservations back, continuously, and getting it
 * wrong in either direction is an overbooking — a guest with a confirmation
 * and no room.
 *
 * ── WHY THIS FILE IS MOSTLY A REFUSAL ────────────────────────────────
 *
 * The console has had a "Sync now" button since before there was a server.
 * What it did was set `lastSync = "just now"` on a local object and raise a
 * toast reading "12 channels synced against tonight's inventory."
 *
 * On demo data that is a placeholder. On a real hotel's data it is a lie with
 * consequences: an operator reads "synced", believes Booking.com is holding
 * the four rooms they have left, and stops checking. Nothing was pushed.
 * Nothing was pulled. The toast is the entire integration.
 *
 * So `notConnected` below REFUSES. It does not report success, and — unlike
 * the supplier seam next door, where "no offers" is a true answer to "what is
 * available" — it does not stay quiet either. Somebody pressed a button and is
 * owed an answer, and the true answer is that no channel manager is attached.
 *
 * Connecting one is a commercial act: each OTA issues credentials against a
 * signed distribution agreement, and there is no code that can produce them.
 * When there is one, `register()` takes it and nothing else here changes.
 * ====================================================================== */

/** Thrown when a channel manager was asked to do something it cannot. */
export class ChannelUnavailable extends ExposableFailure {
  constructor(message: string) {
    /* A refusal, not a fault. The request was well-formed and the operator
       did nothing wrong — the capability is absent. 503, not 500.
       `expose` is the flag http/errors.js reads to let the real message
       through; without it this surfaces as "Something went wrong at our end",
       which is exactly the wrong thing to tell someone whose channel is
       simply not connected. */
    super("ChannelUnavailable", 503, message);
  }
}

const NOTHING_ATTACHED =
  "No channel manager is connected to this installation, so nothing was " +
  "pushed to the channel and no reservations were pulled back. Connecting " +
  "Booking.com, Expedia or Airbnb requires a distribution agreement and " +
  "credentials issued by that channel.";

/* ---------------------------------------------------------------- *
 * THE CHANNEL MANAGER IN USE WHEN THERE IS NONE.
 * ---------------------------------------------------------------- */
export const notConnected = {
  name: "",

  describe() {
    return {
      name: "",
      label: "",
      connected: false,
      capabilities: [],
      why: NOTHING_ATTACHED,
    };
  },

  /*
   * REFUSES rather than returning a harmless empty result.
   *
   * `search()` on the supplier seam returns no offers and no error, because
   * "nothing available" is a true and useful answer. This is not that. A sync
   * that quietly does nothing is indistinguishable from a sync that worked,
   * and the whole point of the button is that the operator is told which.
   */
  async sync() {
    throw new ChannelUnavailable(NOTHING_ATTACHED);
  },
};

/* ---------------------------------------------------------------- *
 * THE REGISTRY.
 *
 * One process, one channel manager. Two managers pushing the same rooms to
 * the same OTA is the overbooking this system exists to prevent, so the
 * registry holds one and replacing it is deliberate.
 * ---------------------------------------------------------------- */

/**
 * WHAT A CHANNEL MANAGER HAS TO BE.
 *
 * `sync` and `name` are required by register() at run time; the rest is what
 * status() reads if it is there. Naming the shape means a partially-built
 * adapter fails where it is written rather than on the first sync.
 */
export interface ChannelManager {
  readonly name: string;
  /** Pushes rates and availability, pulls reservations back. */
  sync(channel?: unknown): Promise<SyncResult | undefined> | SyncResult | undefined;
  describe?(): {
    name?: string;
    label?: string;
    capabilities?: unknown;
    why?: string;
  };
  [key: string]: unknown;
}

/** What one sync actually did. Counts only a manager can have produced. */
export interface SyncResult {
  readonly pushed?: unknown;
  readonly pulled?: unknown;
  readonly at?: unknown;
}

let current: ChannelManager = notConnected;

/* The parameter is what a caller MIGHT hand over, not what a manager is:
   the two checks below are the boundary, and typing them away would leave
   them unreachable and the tests for them uncompilable. */
export function register(
  manager: Partial<ChannelManager> | null | undefined,
): ChannelManager {
  if (!manager || typeof manager.sync !== "function") {
    throw new Error("A channel manager must implement sync().");
  }
  if (!manager.name) {
    throw new Error(
      "A channel manager must have a name. Every sync it performs is recorded " +
      "against it, and an unnamed manager cannot be recorded.");
  }
  current = manager as ChannelManager;
  return current;
}

export const manager = () => current;
export const isConnected = () =>
  current !== notConnected && Boolean(current.name);

/** Reset to nothing. For tests, and for detaching a manager deliberately. */
export function clear() {
  current = notConnected;
}

/**
 * What a settings screen reads.
 *
 * Never throws and never returns a credential — the shape has no field for
 * one, so an API key cannot leak through here.
 */
export function status() {
  try {
    const d = current.describe ? current.describe() : {};
    return {
      name: d.name || current.name || "",
      label: d.label || "",
      connected: isConnected(),
      capabilities: Array.isArray(d.capabilities) ? d.capabilities : [],
      why: d.why || "",
    };
  } catch {
    return { name: "", label: "", connected: false, capabilities: [], why: NOTHING_ATTACHED };
  }
}

/**
 * Push rates and availability to one channel, pull its reservations back.
 *
 * Returns what actually happened. `pushed` and `pulled` are counts a caller
 * may print; there is no code path that returns a count without a manager
 * having produced it.
 */
export async function sync(channel?: { name?: string; [key: string]: unknown }) {
  const out = await current.sync(channel);
  return {
    channel: channel?.name || "",
    manager: current.name || "",
    pushed: Number(out?.pushed) || 0,
    pulled: Number(out?.pulled) || 0,
    at: out?.at instanceof Date ? out.at : new Date(),
  };
}
