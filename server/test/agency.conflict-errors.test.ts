import { describe, expect, it } from "vitest";
import { exclusive } from "../dist/products/agency/shared/util.js";

describe("booking calendar conflict responses", () => {
  it("keeps exclusion violations and rolled-back concurrent writes as conflicts", async () => {
    for (const code of ["23P01", "40P01", "40001"]) {
      await expect(exclusive(Promise.reject({ code }), "Those nights are booked")).rejects.toMatchObject({
        status: 409,
        code: "CONFLICT",
      });
    }
  });
  it("preserves successful writes and does not conceal unexpected database failures", async () => {
    await expect(exclusive(Promise.resolve("saved"), "Booked")).resolves.toBe("saved");
    const error = { code: "XX000", message: "Unexpected database failure" };
    await expect(exclusive(Promise.reject(error), "Booked")).rejects.toBe(error);
  });
});
