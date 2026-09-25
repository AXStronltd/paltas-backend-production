/* ====================================================================== *
 * WHAT A `catch` BINDING ACTUALLY IS.
 *
 * `catch (e)` gives `unknown`, and rightly: anything can be thrown. But
 * some three hundred assertions in this suite read `e.status`, `e.details`
 * and `e.message` off a refusal the service raised, and those are real
 * fields on a real class this repository owns.
 *
 * So rather than casting at each site, they go through here — which is a
 * CHECK and not an assertion. It also fixes something the JavaScript did
 * badly: when a test caught something that was NOT an ApiError, it read
 * `undefined.status`, and the report said "expected 400, got undefined"
 * instead of showing the actual failure. This re-throws it.
 * ====================================================================== */

import { ApiError } from "../src/http/errors.ts";

/**
 * The refusal that was thrown.
 *
 * Re-throws anything that is not one, so a genuine fault surfaces as itself
 * rather than as a confusing assertion about a missing status code.
 */
export function threw(e: unknown): ApiError {
  if (!(e instanceof ApiError)) throw e;
  return e;
}

/** What a throw said, whatever kind of thing it was. */
export const said = (e: unknown): string =>
  (e instanceof Error ? e.message : String(e));
