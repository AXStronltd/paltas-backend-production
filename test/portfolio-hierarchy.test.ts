/* ======================================================================
 * A PORTFOLIO BUILT THROUGH THE CONSOLE IS NOT FLAT.
 *
 * The product states the chain — Property → Building → Unit → Tenant →
 * Lease — on its own Portfolio screen, and the Buildings screen tells a new
 * company to "add the properties first, then the buildings on them".
 *
 * Neither form could say which. `buildings` had no siteId, and `units`
 * carried `buildingName` as free text with a comment saying the picker came
 * later. So every record a customer created through the console was an
 * orphan: two "Block A"s on different properties were one building to
 * anything that counted through them, and Almas Tower's first building had
 * no property at all.
 *
 * The registry always allowed the links. Only the form list omitted them.
 * ====================================================================== */
import { test } from "node:test";
import assert from "node:assert/strict";

import { CONSOLE_FORMS } from "../src/domain/console-map.ts";
import { RESOURCES } from "../src/domain/registry.ts";

/** The console field name that maps to an API field, or null. */
function fieldFor(screen: string, apiField: string): string | null {
  const form = (CONSOLE_FORMS as Record<string, { fields: Record<string, string> }>)[screen];
  assert.ok(form, `no console form for ${screen}`);
  for (const [console_, api] of Object.entries(form.fields)) {
    if (api === apiField) return console_;
  }
  return null;
}

test("a building can say which property it stands on", () => {
  assert.ok(fieldFor("buildings", "siteId"),
    "the buildings form cannot name a property, so every building is an orphan");
});

test("a unit can say which building it is in, and which property", () => {
  assert.ok(fieldFor("units", "buildingId"),
    "a unit cannot point at its building — buildingName is a copy of a name, not a link");
  assert.ok(fieldFor("units", "siteId"),
    "a unit cannot name its property");
});

test("the links the forms offer are real columns on the resource", () => {
  /*
   * A form field naming an API field the resource does not have is refused
   * at create time, with the customer told their choice does not exist. This
   * is the check that stops that reaching them.
   */
  const reg = RESOURCES as unknown as Record<string, { fields: Record<string, string> }>;
  for (const [screen, api] of [["buildings", "siteId"], ["units", "buildingId"], ["units", "siteId"]] as const) {
    const resource = (CONSOLE_FORMS as Record<string, { resource: string }>)[screen]!.resource;
    const fields = reg[resource]?.fields || {};
    assert.ok(api in fields, `${resource} has no ${api}, but the ${screen} form offers it`);
    assert.match(String(fields[api]), /^id:/, `${resource}.${api} is not a reference, so it cannot be a picker`);
  }
});

test("neither link is required — a unit may exist before its building does", () => {
  /*
   * The Command Centre says exactly that: "a unit can exist before its
   * building does". Making either id required would contradict the product's
   * own instruction and block the fastest way in for a company mid-migration.
   */
  const reg = RESOURCES as unknown as Record<string, { required?: readonly string[] }>;
  for (const [resource, api] of [["buildings", "siteId"], ["units", "buildingId"], ["units", "siteId"]] as const) {
    const required = reg[resource]?.required || [];
    assert.ok(!required.includes(api), `${resource} requires ${api}, which blocks a partial portfolio`);
  }
});
