import assert from "node:assert/strict";
import { generateLayout } from "./lib/property-layout.mjs";
const floors = Array.from({ length: 12 }, (_, i) => ({ floor: i + 1, doors: 4 }));
const west = generateLayout({ buildingId: "w", initial: "W", floors }),
  east = generateLayout({ buildingId: "e", initial: "E", floors });
assert.equal(west.length + east.length, 96);
assert.equal(west[0].unitNo, "0101 W");
assert.equal(west.at(-1).unitNo, "1204 W");
assert(west.some((u) => u.floor === "6" && u.unitNo === "0603 W"));
assert(east.some((u) => u.floor === "11" && u.unitNo === "1102 E"));
assert.equal(new Set([...west, ...east].map((u) => u.unitNo)).size, 96);
assert.equal(
  generateLayout({
    floors: [
      { floor: 1, doors: 2 },
      { floor: 2, doors: 5 },
    ],
  }).length,
  7,
);
assert.throws(() => generateLayout({ floors: [{ floor: 1, doors: 0 }] }));
assert.throws(() =>
  generateLayout({
    floors: [
      { floor: 1, doors: 3 },
      { floor: 1, doors: 2 },
    ],
  }),
);
assert.throws(() =>
  generateLayout({
    floors: [
      { floor: 1, doors: 99 },
      { floor: 2, doors: 99 },
      { floor: 3, doors: 99 },
      { floor: 4, doors: 99 },
      { floor: 5, doors: 99 },
      { floor: 6, doors: 99 },
    ],
  }),
);
console.log(
  "PASS universal property generator: 96 units, correct floor/door/block names, variable apartments per floor, unique labels and bounds",
);
