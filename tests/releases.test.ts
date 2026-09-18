import assert from "node:assert/strict";
import test from "node:test";
import { buildReleaseCalendar, linkReleasePosts, releasesForRadar } from "../src/lib/releases";
import type { LandedRelease } from "../src/lib/types";
import type { StoredContentInput } from "../src/lib/content-store";

test("release radar prefers evidenced official monthly posts for stable and patch releases", () => {
  const ha: LandedRelease = {
    id: "ha", product: "Home Assistant", repository: "home-assistant/core", name: "2026.9.3", tag: "2026.9.3",
    url: "https://github.com/home-assistant/core/releases/tag/2026.9.3", publishedAt: "2026-09-10T12:00:00Z", channel: "stable", accent: "blue",
  };
  const esp = { ...ha, id: "esp", product: "ESPHome", repository: "esphome/esphome", tag: "2026.9.0" };
  const haPost: StoredContentInput = {
    id: "ha-post", kind: "official_post", source: "Home Assistant Blog", title: "2026.9: There's room on this bus",
    url: "https://www.home-assistant.io/blog/2026/09/02/release-20269/", publishedAt: "2026-09-02T00:00:00Z", body: null, mediaUrls: [],
  };
  const espPost = { ...haPost, id: "esp-post", source: "ESPHome Blog", title: "ESPHome 2026.9.0: Faster builds and encrypted updates", url: "https://esphome.io/blog/2026/09/16/esphome-2026-9/", publishedAt: "2026-09-16T00:00:00Z" };
  const posts = [
    { ...haPost, id: "outside", kind: "external_coverage" as const },
    { ...haPost, id: "spoof", url: "https://www.home-assistant.io.example.com/blog/2026/09/02/release-20269/" },
    { ...haPost, id: "unrelated", url: "https://www.home-assistant.io/blog/2026/09/02/community/" },
    haPost, espPost,
  ];
  const result = linkReleasePosts([ha, esp, { ...ha, channel: "prerelease" }, { ...ha, tag: "2026.10.0" }], posts, "2026-09-18T00:00:00Z");
  assert.equal(result[0].releasePostUrl, haPost.url);
  assert.equal(result[0].releasePostSourceId, haPost.id);
  assert.equal(result[0].url, ha.url);
  assert.equal(result[1].releasePostUrl, espPost.url);
  assert.equal(result[2].releasePostUrl, undefined);
  assert.equal(result[3].releasePostUrl, undefined);
  assert.equal(linkReleasePosts([esp], posts, "2026-09-15T00:00:00Z")[0].releasePostUrl, undefined);
  assert.equal(ha.releasePostUrl, undefined);
});

const cycles = [
  { product: "Home Assistant", rule: "first-wednesday" as const, beta_days_before: 7, release_offset_days: 0, accent: "blue" },
  { product: "ESPHome", rule: "first-wednesday" as const, beta_days_before: 14, release_offset_days: 14, accent: "green" },
];

test("calculates first-Wednesday releases with product-specific beta periods", () => {
  const events = buildReleaseCalendar(new Date("2026-08-01T12:00:00Z"), cycles);
  assert.deepEqual(events.slice(0, 4).map(({ product, kind, date, version }) => ({ product, kind, date, version })), [
    { product: "Home Assistant", kind: "Release", date: "2026-08-05", version: "2026.8" },
    { product: "ESPHome", kind: "Beta", date: "2026-08-05", version: "2026.8" },
    { product: "ESPHome", kind: "Release", date: "2026-08-19", version: "2026.8" },
    { product: "Home Assistant", kind: "Beta", date: "2026-08-26", version: "2026.9" },
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
  assert.deepEqual(events.slice(0, 3).map(({ product, kind, date, version }) => ({ product, kind, date, version })), [
    { product: "Home Assistant", kind: "Beta", date: "2026-12-30", version: "2027.1" },
    { product: "Home Assistant", kind: "Release", date: "2027-01-06", version: "2027.1" },
    { product: "ESPHome", kind: "Beta", date: "2027-01-06", version: "2027.1" },
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

test("hides prereleases superseded by a matching stable release in the radar", () => {
  const release = (tag: string, channel: LandedRelease["channel"], product = "Home Assistant"): LandedRelease => ({
    id: `${product}:${tag}`,
    product,
    repository: "owner/repository",
    name: tag,
    tag,
    url: `https://github.com/owner/repository/releases/tag/${tag}`,
    publishedAt: "2026-09-02T12:00:00Z",
    channel,
    accent: "blue",
  });
  const releases = [
    release("2026.9.0b9", "prerelease"),
    release("2026.9.0", "stable"),
    release("2026.10.0b1", "prerelease"),
    release("2026.9.0b1", "prerelease", "ESPHome"),
  ];

  assert.deepEqual(releasesForRadar(releases).map(({ product, tag }) => `${product}:${tag}`), [
    "Home Assistant:2026.9.0",
    "Home Assistant:2026.10.0b1",
    "ESPHome:2026.9.0b1",
  ]);
});
