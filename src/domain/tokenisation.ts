import { ExposableFailure, messageOf } from "../http/errors.ts";

/* ====================================================================== *
 * THE TOKENISATION ADAPTER.
 *
 * PALTAS does not mint anything. It does not hold a key, sign a transaction,
 * or know what a token balance is. A regulated tokenisation provider does
 * those things, and this file is the shape of the conversation with one.
 *
 *     PALTAS  ->  this adapter  ->  regulated provider  ->  DLT / custodian
 *
 * ── WHAT THIS FILE REFUSES TO DO ────────────────────────────────────────
 *
 * No provider is connected. So every write here THROWS, with a sentence
 * saying so. It does not return a plausible transaction hash, it does not
 * invent a token id, and it does not write a TokenHolding row.
 *
 * That is the entire design decision. A fake mint that returns
 * "0x7a3f…" and a holdings screen showing 4,000 units is indistinguishable
 * from a working integration right up to the moment somebody tries to
 * transfer or redeem — at which point the platform has told an investor they
 * own something that does not exist. An empty holdings screen with "no
 * provider connected" on it is worse to look at and infinitely better to own.
 *
 * ── WHAT IT RECORDS ─────────────────────────────────────────────────────
 *
 * When a provider IS connected, PALTAS stores the references the provider
 * returns — `providerRef`, `txRef`, `contractRef`, `custodianRef` — and those
 * are authoritative. TokenHolding.units is what the provider last reported,
 * never a number this service added up from orders. If the two disagree, the
 * provider is right and the disagreement is the finding.
 * ====================================================================== */

/** Thrown when something asks for a capability no provider is behind. */
export class TokenisationUnavailable extends ExposableFailure {
  constructor(message: string) {
    /* 503, not 500: nothing is broken. A capability is absent. */
    super("TokenisationUnavailable", 503, message);
  }
}

/**
 * The interface a provider must implement.
 *
 * Documented as a shape rather than enforced as a class, because the
 * implementation will be somebody else's SDK wrapped thinly — and a base class
 * that the wrapper has to extend is a constraint with no benefit.
 *
 *   name            string, recorded on every row this provider touches
 *   sandbox         boolean, true for a test environment
 *   describe()      -> { name, sandbox, capabilities: string[] }
 *   mint({...})     -> { providerRef, txRef, units, contractRef?, chain? }
 *   transfer({...}) -> { providerRef, txRef, units }
 *   positionsFor({offeringRef}) -> [{ investorRef, units, providerRef, asAt }]
 *
 * Every method is async and may throw. Nothing may return a value it did not
 * get from the provider.
 */

/**
 * The provider in use when there is none.
 *
 * Reads return nothing — which is true. Writes refuse — which is also true.
 */
export const notConnected = {
  name: "",
  sandbox: false,

  describe() {
    return {
      name: "",
      connected: false,
      sandbox: false,
      capabilities: [],
      why: "No tokenisation provider is connected to this installation. " +
           "Units cannot be issued, transferred or reported until an approved " +
           "provider is configured.",
    };
  },

  async mint() {
    throw new TokenisationUnavailable(
      "No tokenisation provider is connected, so units cannot be issued. " +
      "The offering, the orders and the investor register are unaffected — " +
      "nothing has been recorded as issued.");
  },

  async transfer() {
    throw new TokenisationUnavailable(
      "No tokenisation provider is connected, so units cannot be transferred.");
  },

  /*
   * An empty list, not an error.
   *
   * "Which positions exist?" has a correct answer when no provider is
   * connected, and it is "none that this service can see". A screen asking for
   * holdings should render empty rather than broken.
   */
  async positionsFor() {
    return [];
  },
};

/* ---------------------------------------------------------------- *
 * THE REGISTRY.
 *
 * One process, one provider, chosen by configuration. `register()` exists so
 * a real provider can be attached without this file knowing anything about
 * it, and so a test can attach a fake that is obviously a fake.
 * ---------------------------------------------------------------- */

/**
 * WHAT A TOKENISATION PROVIDER HAS TO BE.
 *
 * `mint` is the one register() insists on; the rest is what status() reads if
 * it is there. Named so that a half-built provider fails where it is written.
 */
/**
 * What a provider says it minted.
 *
 * `providerRef` and `units` are what PALTAS stores against the holding and
 * are the two it cannot do without. Everything else is carried when the
 * provider gives it and left empty when it does not — nothing here is
 * invented on a provider's behalf.
 */
export interface MintResult {
  readonly providerRef: string;
  readonly units: number;
  readonly txRef?: string;
  readonly contractRef?: string;
  readonly chain?: string;
  readonly custodian?: string;
  readonly custodianRef?: string;
  readonly walletRef?: string;
  /** When the PROVIDER says it happened, if it says. */
  readonly asAt?: Date | string | null;
}

export interface TokenisationProvider {
  readonly name?: string;
  readonly sandbox?: boolean;
  mint(request: MintRequest): Promise<MintResult> | MintResult;
  /**
   * WHO HOLDS WHAT, ACCORDING TO THE PROVIDER.
   *
   * A READ, so the unconnected provider answers `[]` rather than throwing:
   * "none that this service can see" is a true answer to "what does this
   * offering have outstanding", and a screen asking it must render.
   */
  positionsFor?(query: { offeringRef?: string }): Promise<readonly MintResult[]>;
  describe?(): {
    name?: string;
    sandbox?: boolean;
    capabilities?: unknown;
    why?: string;
  };
  [key: string]: unknown;
}

let current: TokenisationProvider = notConnected;

export function register(provider: TokenisationProvider): TokenisationProvider {
  if (!provider || typeof provider.mint !== "function") {
    throw new Error("A tokenisation provider must implement at least mint().");
  }
  current = provider;
  return current;
}

export const provider = () => current;
export const isConnected = () => current !== notConnected && Boolean(current.name);

/** Reset to nothing. For tests, and for disabling a provider deliberately. */
export function clear() {
  current = notConnected;
}

/**
 * What the Token Holdings and Settings screens read.
 *
 * Never throws: a screen asking "is tokenisation available" must get an
 * answer, and "no" is an answer.
 */
export function status() {
  try {
    const d = current.describe ? current.describe() : {};
    return {
      connected: isConnected(),
      name: d.name || current.name || "",
      sandbox: Boolean(d.sandbox ?? current.sandbox),
      capabilities: d.capabilities || [],
      why: d.why || "",
    };
  } catch (e) {
    return {
      connected: false, name: "", sandbox: false, capabilities: [],
      why: "The configured tokenisation provider could not describe itself: " +
           messageOf(e).slice(0, 160),
    };
  }
}

/** What minting one position needs to know. */
export interface MintRequest {
  readonly offeringRef?: string;
  readonly investorRef?: string;
  readonly units: number;
}

/* ---------------------------------------------------------------- *
 * SANDBOX.
 *
 * A provider that is honestly fake, for technical testing, and which cannot
 * be mistaken for a real one:
 *
 *   - every reference it returns starts with `SANDBOX-`
 *   - `sandbox` is true, and routes refuse to attach it to a production
 *     offering (Offering.sandbox must also be true)
 *   - it is never registered by default; something has to ask for it
 *
 * It is here rather than in the test folder because the requirement was a
 * "clearly marked SANDBOX/TEST environment for technical testing" that the
 * running service can offer. Marked is the operative word.
 * ---------------------------------------------------------------- */
export function sandboxProvider({ seq = 0 }: { seq?: number } = {}): TokenisationProvider {
  let n = seq;
  const ref = (kind: string): string => `SANDBOX-${kind}-${String(++n).padStart(6, "0")}`;
  return {
    name: "sandbox",
    sandbox: true,
    describe() {
      return {
        name: "sandbox", connected: true, sandbox: true,
        capabilities: ["mint", "transfer", "positions"],
        why: "A SANDBOX provider. Every reference it returns begins with " +
             "SANDBOX- and none of it exists anywhere outside this database.",
      };
    },
    async mint({ offeringRef, investorRef, units }: MintRequest) {
      if (!units || units <= 0) throw new Error("mint needs a positive number of units");
      return {
        providerRef: ref("POS"), txRef: ref("TX"),
        units, chain: "sandbox", contractRef: `SANDBOX-CONTRACT-${offeringRef || "NONE"}`,
        walletRef: `SANDBOX-WALLET-${investorRef || "NONE"}`,
        asAt: null,     /* the caller stamps time; this module never invents one */
      };
    },
    async transfer({ units }: { units: number }) {
      return { providerRef: ref("POS"), txRef: ref("TX"), units };
    },
    async positionsFor() {
      /* A sandbox does not pretend to have history it was not given. */
      return [];
    },
  };
}
