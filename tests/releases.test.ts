import assert from "node:assert/strict";
import test from "node:test";
import { buildReleaseCalendar } from "../src/lib/releases";

const cycles = [
  { product: "Home Assistant", rule: "first-wednesday" as const, beta_days_before: 7, release_offset_days: 0, accent: "blue" },
  { product: "ESPHome", rule: "first-wednesday" as const, beta_days_before: 14, release_offset_days: 14, accent: "green" },
];

test("calculates first-Wednesday releases with product-specific beta periods", () => {
  const events = buildReleaseCalendar(new Date("2026-08-01T12:00:00Z"), cycles);
  assert.deepEqual(events.slice(0, 4).map(({ product, kind, date }) => ({ product, kind, date })), [
    { product: "Home Assistant", kind: "Release", date: "2026-08-05" },
    { product: "ESPHome", kind: "Beta", date: "2026-08-05" },
    { product: "ESPHome", kind: "Release", date: "2026-08-19" },
    { product: "Home Assistant", kind: "Beta", date: "2026-08-26" },
  ]);
});

test("keeps the current release when run during its beta week", () => {
  const events = buildReleaseCalendar(new Date("2026-09-01T12:00:00Z"), cycles);
  assert.equal(events[0].date, "2026-09-02");
  assert.equal(events[0].kind, "Release");
});

test("includes a beta that falls in the previous month", () => {
  const events = buildReleaseCalendar("2026-07-28", cycles);
  assert.deepEqual(events.slice(0, 2).map(({ product, kind, date }) => ({ product, kind, date })), [
    { product: "Home Assistant", kind: "Beta", date: "2026-07-29" },
    { product: "Home Assistant", kind: "Release", date: "2026-08-05" },
  ]);
});

test("rolls release schedules across a year boundary", () => {
  const events = buildReleaseCalendar("2026-12-30", cycles, 2);
  assert.deepEqual(events.slice(0, 3).map(({ product, kind, date }) => ({ product, kind, date })), [
    { product: "Home Assistant", kind: "Beta", date: "2026-12-30" },
    { product: "Home Assistant", kind: "Release", date: "2027-01-06" },
    { product: "ESPHome", kind: "Beta", date: "2027-01-06" },
  ]);
});

test("rejects malformed calendar dates", () => {
  assert.throws(() => buildReleaseCalendar("2026-02-30", cycles), /valid calendar date/);
  assert.throws(() => buildReleaseCalendar("31-08-2026", cycles), /YYYY-MM-DD/);
});

test("never shows scheduled events more than 45 days ahead", () => {
  const events = buildReleaseCalendar("2026-08-31", cycles, 4, 45);
  assert.ok(events.length > 0);
  assert.equal(events.at(-1)?.date, "2026-10-07");
  assert.ok(events.every((event) => event.date <= "2026-10-15"));
  assert.deepEqual(buildReleaseCalendar("2026-08-31", cycles, 4, 0), []);
});
