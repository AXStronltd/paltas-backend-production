/*
 * Price comparison — the guards, not the happy path.
 *
 * Every call here is a fake. The real endpoint costs 30 credits against a
 * metered account, and a suite that spends money is a suite people stop
 * running.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  registerCompare, clearCompare, compareStatus, comparePrices, forgetComparisons,
} from "../src/domain/compare.js";

const HOTEL = { hotelId: "lp1a2b", name: "Al Marwa Rayhaan by Rotana", city: "Makkah", country: "SA", stars: 5 };
const supplierThatSells = { hotel: async () => HOTEL };
const supplierThatDoesNot = { hotel: async () => null };

function fakeProvider(answer, log = []) {
  return {
    name: "stayingapi",
    describe: () => ({ name: "stayingapi", label: "StayingAPI", sandbox: true, why: "connected" }),
    compare: async (args) => { log.push(args); return typeof answer === "function" ? answer(args) : answer; },
  };
}

const STAY = { hotelId: "lp1a2b", country: "SA", currency: "GBP",
               checkIn: "2026-11-02", checkOut: "2026-11-05", guests: 2 };

test.beforeEach(() => { clearCompare(); forgetComparisons(); });
test.after(() => clearCompare());

test("with no provider it says so and takes nothing off the page", async () => {
  const out = await comparePrices({ supplier: supplierThatSells, ...STAY });
  assert.deepEqual(out.offers, []);
  assert.equal(out.provider.connected, false);
  assert.match(out.why, /No price-comparison provider is connected/);
  /* The important half: it RESOLVED rather than threw. A comparison is an
     extra, and a failing extra must not remove a bookable room. */
  assert.ok(out.basis, "the caveat is missing even when there is nothing to caveat");
});

test("a hotel PALTAS does not sell is never priced, and costs nothing", async () => {
  const log = [];
  registerCompare(fakeProvider({ offers: [] }, log));

  const out = await comparePrices({ supplier: supplierThatDoesNot, ...STAY });
  assert.match(out.why, /does not sell this hotel/);
  assert.equal(log.length, 0,
    "a 30-credit comparison was requested for a hotel PALTAS does not sell");
});

test("the property name comes from the supplier, never from the caller", async () => {
  const log = [];
  registerCompare(fakeProvider({ offers: [], currency: "GBP" }, log));

  /* A caller trying to smuggle its own property in. */
  await comparePrices({
    supplier: supplierThatSells, ...STAY,
    name: "Somebody Else's Hotel", location: "Monaco", googleHotelId: "abc",
  });

  assert.equal(log.length, 1);
  assert.equal(log[0].name, HOTEL.name,
    "the caller chose which property was priced at PALTAS's expense");
  assert.equal(log[0].location, "Makkah");
  assert.equal(log[0].adults, 2);
  assert.equal(log[0].currency, "GBP");
});

test("an offer in another currency is dropped and counted, never converted", async () => {
  registerCompare(fakeProvider({
    currency: "GBP",
    offers: [
      { ota: "Booking.com", price: { amountMinor: 41200, currency: "GBP" }, url: "https://x", bookable: false },
      { ota: "Hotels.com", price: { amountMinor: 39900, currency: "GBP" }, url: "https://y", bookable: false },
    ],
    min: { amountMinor: 39900, currency: "GBP" },
    median: { amountMinor: 41200, currency: "GBP" },
    dropped: 2,
  }));

  const out = await comparePrices({ supplier: supplierThatSells, ...STAY });
  assert.equal(out.offers.length, 2);
  assert.equal(out.dropped, 2, "the dropped count was lost, so a partial comparison looks whole");
  assert.deepEqual(out.min, { amountMinor: 39900, currency: "GBP" });
  for (const o of out.offers) {
    assert.equal(o.price.currency, "GBP");
    assert.equal(o.bookable, false, "another seller's offer is marked bookable on PALTAS");
  }
});

test("the comparison always carries the sentence that keeps it honest", async () => {
  registerCompare(fakeProvider({ currency: "GBP", offers: [
    { ota: "Booking.com", price: { amountMinor: 41200, currency: "GBP" }, url: "https://x" }] }));
  const out = await comparePrices({ supplier: supplierThatSells, ...STAY });

  /*
   * PALTAS quotes one room on one board basis; Google reports what sellers
   * advertise for the property. Printing two totals side by side without
   * saying that is a comparison that reads as like-for-like and is not.
   */
  assert.match(out.basis, /Room type, board basis and cancellation terms may differ/);
});

test("the same question is asked once, however many times it is put", async () => {
  const log = [];
  registerCompare(fakeProvider({ currency: "GBP", offers: [] }, log));

  const a = await comparePrices({ supplier: supplierThatSells, ...STAY });
  const b = await comparePrices({ supplier: supplierThatSells, ...STAY });
  assert.equal(log.length, 1, "a cached comparison was bought twice");
  assert.ok(!a.cached, "the first answer claimed to be cached");
  assert.ok(b.cached, "the second answer was not served from cache");

  /* Anything that changes the answer must miss: different nights are a
     different price, and a different guest count is a different room. */
  await comparePrices({ supplier: supplierThatSells, ...STAY, checkOut: "2026-11-06" });
  assert.equal(log.length, 2, "a different stay was served a stale answer");
  await comparePrices({ supplier: supplierThatSells, ...STAY, guests: 4 });
  assert.equal(log.length, 3, "a different party size was served a stale answer");
});

test("a provider that fails leaves the room alone", async () => {
  registerCompare({
    describe: () => ({ name: "stayingapi", sandbox: false }),
    compare: async () => { throw new Error("StayingAPI is out of credits."); },
  });

  const out = await comparePrices({ supplier: supplierThatSells, ...STAY });
  assert.deepEqual(out.offers, []);
  assert.match(out.why, /out of credits/);
  assert.equal(out.hotel.name, HOTEL.name, "a failed extra lost the hotel it was attached to");
});

test("a supplier that cannot look a hotel up spends nothing", async () => {
  const log = [];
  registerCompare(fakeProvider({ offers: [] }, log));
  const out = await comparePrices({ supplier: {}, ...STAY });
  assert.match(out.why, /does not sell this hotel/);
  assert.equal(log.length, 0);
});

test("status never carries a credential", () => {
  registerCompare(fakeProvider({ offers: [] }));
  const s = JSON.stringify(compareStatus());
  assert.ok(!/stay_(live|test)_/.test(s), "compareStatus() exposes a key-shaped string");
  assert.equal(compareStatus().connected, true);
  clearCompare();
  assert.equal(compareStatus().connected, false);
});
