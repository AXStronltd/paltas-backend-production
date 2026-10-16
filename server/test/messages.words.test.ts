// What people read in a refusal: money as money with its currency, modules by their names — never minor units or
// internal keys.
import { describe, expect, it } from "vitest";
import { entitlements } from "@paltas/contracts";
import { formatMoney } from "../dist/lib/money.js";

describe("server messages are written for people", () => {
  it("formats minor units as money with the currency and its own decimals", () => {
    expect(formatMoney(6_630_000, "KES")).toBe("KES 66,300.00");
    expect(formatMoney(-6_630_000, "KES")).toBe("KES -66,300.00");
    expect(formatMoney(48_000, "USD")).toBe("USD 480.00");
    expect(formatMoney(150_000, "UGX")).toBe("UGX 150,000");
  });

  it("names a module in words even when its catalogue row is missing", () => {
    const empty = { modules: [], plans: [] } as unknown as Parameters<typeof entitlements.moduleName>[0];
    expect(entitlements.moduleName(empty, "maint")).toBe("Maintenance");
    expect(entitlements.moduleName(empty, "crm")).toBe("Advanced CRM and Marketing");
    expect(entitlements.moduleName(empty, "something-new")).toBe("This module");
  });
});
