import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseReleaseCalendar, collectReleaseCalendar } from "../src/lib/release-calendar-feed";
import { releaseTargetsForDate } from "../scripts/collect";

const source = { url: "https://example.org/releases.ics", versions: [{ uid: "music", occurrence: "2026-12-16", version: "2.11" }] };
const event = (lines: string[]) => ["BEGIN:VEVENT", ...lines, "END:VEVENT"].join("\r\n");
const calendar = (...events: string[]) => ["BEGIN:VCALENDAR", "VERSION:2.0", ...events, "END:VCALENDAR", ""].join("\r\n");
const music = event(["UID:music", "DTSTART;VALUE=DATE:20261216", "DTEND;VALUE=DATE:20261217", "SUMMARY:Music Assistant Stable Release", "RRULE:FREQ=MONTHLY;INTERVAL=3;BYDAY=3WE"]);

test("official recurrence schedules replace date guesses, with versions only when known", () => {
  const body = calendar(music,
    event(["UID:ha", "DTSTART;VALUE=DATE:20210106", "SUMMARY:Home Assistant Core Release", "RRULE:FREQ=MONTHLY;BYDAY=1WE"]),
    event(["UID:ha-beta", "DTSTART;VALUE=DATE:20210224", "SUMMARY:Home Assistant Core Beta Release", "RRULE:FREQ=MONTHLY;BYDAY=-1WE"]),
    event(["UID:esp", "DTSTART;VALUE=DATE:20261216", "SUMMARY:ESPHome Stable Release", "RRULE:FREQ=MONTHLY;BYDAY=3WE"]),
    event(["UID:sync", "DTSTART;VALUE=DATE:20261201", "SUMMARY:Music Assistant Community Sync", "RRULE:FREQ=WEEKLY"]));
  const releases = parseReleaseCalendar(body, source, "2026-11-27");
  assert.deepEqual(releases.map(({ product, kind, date, version }) => ({ product, kind, date, version })), [
    { product: "Home Assistant", kind: "Release", date: "2026-12-02", version: "2026.12" },
    { product: "ESPHome", kind: "Release", date: "2026-12-16", version: "2026.12" },
    { product: "Music Assistant", kind: "Release", date: "2026-12-16", version: "2.11" },
    { product: "Home Assistant", kind: "Beta", date: "2026-12-30", version: "2027.1" },
    { product: "Home Assistant", kind: "Release", date: "2027-01-06", version: "2027.1" },
  ]);
  assert.equal(parseReleaseCalendar(body, source, "2027-03-01").find((e) => e.product === "Music Assistant")?.version, undefined);
  assert.deepEqual(releaseTargetsForDate("2026-12-16", releases).find((e) => e.product === "Music Assistant"), { product: "Music Assistant", version: "2.11", releaseDate: "2026-12-16" });
  // Stable date outside the visible horizon still supplies the beta's version.
  assert.equal(parseReleaseCalendar(body, source, "2026-11-16").find((e) => e.date === "2026-12-30")?.version, "2027.1");
});

test("moved and cancelled exceptions, EXDATE and sequence revisions do not leave duplicate dates", () => {
  const body = calendar(music,
    event(["UID:music", "RECURRENCE-ID;VALUE=DATE:20261216", "DTSTART;VALUE=DATE:20261218", "SUMMARY:Music Assistant Stable Release", "SEQUENCE:1"]),
    event(["UID:music", "RECURRENCE-ID;VALUE=DATE:20261216", "DTSTART;VALUE=DATE:20261217", "SUMMARY:Music Assistant Stable Release", "SEQUENCE:2"]),
    event(["UID:esp", "DTSTART;VALUE=DATE:20261202", "SUMMARY:ESPHome Beta Release", "RRULE:FREQ=WEEKLY;COUNT=4", "EXDATE;VALUE=DATE:20261209"]),
    event(["UID:esp", "RECURRENCE-ID;VALUE=DATE:20261216", "DTSTART;VALUE=DATE:20261216", "SUMMARY:ESPHome Beta Release", "STATUS:CANCELLED"]));
  const results = parseReleaseCalendar(body, source, "2026-11-27");
  assert.deepEqual(results.map((e) => e.date), ["2026-12-02", "2026-12-17", "2026-12-23"]);
  assert.equal(results[1].version, "2.11");
});

test("all-day dates remain literal while timed dates use the publication timezone", () => {
  const body = calendar(music,
    event(["UID:timed", "DTSTART:20261201T233000Z", "SUMMARY:Home Assistant Core Release"]));
  assert.deepEqual(parseReleaseCalendar(body, source, "2026-11-27").map((e) => e.date), ["2026-12-02", "2026-12-16"]);
  assert.throws(() => parseReleaseCalendar("BEGIN:VCALENDAR", source, "2026-11-27"), /Incomplete/);
  assert.throws(() => parseReleaseCalendar(calendar(), source, "2026-11-27"), /no recognized/);
});

test("unavailable or invalid feeds immediately use yesterday's complete release snapshot without retrying", async () => {
  const root = await mkdtemp(join(tmpdir(), "ohf-release-calendar-"));
  try {
    const editionDirectory = join(root, "editions");
    const cacheDirectory = join(root, "cache");
    await mkdir(editionDirectory);
    const previous = { date: "2026-11-26", releases: [
      { product: "Expired", kind: "Release", date: "2026-11-26" },
      { product: "Music Assistant", kind: "Release", date: "2026-12-16", version: "2.11", accent: "rust" },
      { product: "Conference", kind: "Event", date: "2026-12-12" },
      { product: "Far future", kind: "Release", date: "2027-03-01" },
    ] };
    await writeFile(join(editionDirectory, "2026-11-26.json"), JSON.stringify(previous));
    for (const response of [new Response("Unavailable", { status: 503 }), new Response("invalid calendar")]) {
      let calls = 0;
      const releases = await collectReleaseCalendar({ source, editionDate: "2026-11-27", editionDirectory, cacheDirectory,
        fetcher: (async () => { calls++; return response; }) as typeof fetch });
      assert.equal(calls, 1);
      assert.deepEqual(releases, [previous.releases[1]]);
      assert.equal(JSON.parse(await readFile(join(cacheDirectory, "2026-11-27.json"), "utf8")).mode, "previous-edition");
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});


test("embedded timezones follow daylight saving transitions", () => {
  const zone = ["BEGIN:VTIMEZONE", "TZID:Europe/Amsterdam",
    "BEGIN:STANDARD", "DTSTART:19701025T030000", "TZOFFSETFROM:+0200", "TZOFFSETTO:+0100", "RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU", "END:STANDARD",
    "BEGIN:DAYLIGHT", "DTSTART:19700329T020000", "TZOFFSETFROM:+0100", "TZOFFSETTO:+0200", "RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU", "END:DAYLIGHT", "END:VTIMEZONE"].join("\r\n");
  const body = calendar(zone, event(["UID:dst", "DTSTART;TZID=Europe/Amsterdam:20260328T013000", "SUMMARY:Home Assistant Core Release", "RRULE:FREQ=DAILY;COUNT=3"]));
  assert.deepEqual(parseReleaseCalendar(body, source, "2026-03-27", 45, "UTC").map((e) => e.date), ["2026-03-28", "2026-03-29"]);
  assert.throws(() => releaseTargetsForDate("2027-03-17", [{ product: "Music Assistant", kind: "Release", date: "2027-03-17", accent: "rust" }]), /evidenced version/);
});
