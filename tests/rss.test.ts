import assert from "node:assert/strict";
import test from "node:test";
import { buildRssFeed, rssInternals } from "../src/lib/rss";
import type { Edition } from "../src/lib/types";

const edition: Edition = {
  date: "2026-08-31",
  generatedAt: "2026-08-31T08:30:00Z",
  windowStart: "2026-08-30T21:59:00Z",
  windowEnd: "2026-08-31T21:59:00Z",
  timezone: "Europe/Amsterdam",
  stats: { mergedPullRequests: 1, repositories: 1, contributors: 1, dependencyUpdates: 0 },
  lead: null,
  highlights: [],
  briefs: [],
  dependencies: [],
  releases: [],
  articles: [{
    id: "energy-control",
    title: "Energy & control <arrive>",
    dek: "A safer & faster energy flow.",
    body: ["The first paragraph explains <why>."],
    kind: "daily",
    placement: "lead",
    score: 90,
    contributors: ["frenck"],
    topics: ["Energy & solar"],
    pullRequests: [],
    media: [],
  }],
};

test("builds an RSS feed with canonical base-path article URLs and escaped copy", () => {
  const feed = buildRssFeed({
    site: new URL("https://paulusschoutsen.nl/"),
    basePath: "/ohf-daily/",
    editions: [edition],
  });

  assert.match(feed, /<rss version="2\.0"/);
  assert.match(feed, /https:\/\/paulusschoutsen\.nl\/ohf-daily\/rss\.xml/);
  assert.match(feed, /https:\/\/paulusschoutsen\.nl\/ohf-daily\/edition\/2026-08-31\/article\/energy-control\//);
  assert.match(feed, /Energy &amp; control &lt;arrive&gt;/);
  assert.match(feed, /A safer &amp; faster energy flow\./);
  assert.match(feed, /Mon, 31 Aug 2026 08:30:00 GMT/);
});

test("preserves a configured site path when Astro has no separate base path", () => {
  assert.equal(
    rssInternals.absoluteUrl(new URL("https://balloob.github.io/ohf-daily/"), "/", "rss.xml"),
    "https://balloob.github.io/ohf-daily/rss.xml",
  );
});

test("does not publish demonstration editions", () => {
  const feed = buildRssFeed({
    site: new URL("https://example.com/"),
    basePath: "/",
    editions: [{ ...edition, isDemo: true }],
  });
  assert.doesNotMatch(feed, /Energy &amp; control/);
});
