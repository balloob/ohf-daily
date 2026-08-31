import assert from "node:assert/strict";
import test from "node:test";
import {
  backfillDatesNewestFirst,
  GitHubClient,
  buildAuthoritativeProjectPulse,
  buildProjectPulse,
  classify,
  committedMediaUrls,
  dateInTimeZone,
  endOfEditionDate,
  extractMediaUrls,
  firstImage,
  latestScheduledReleaseDate,
  landedReleasesFromHistory,
  reportingWindow,
  releaseTargetsForDate,
  releasePreviewTargetsForDate,
  reviewCredits,
  sentenceSummary,
  shouldInspectPullFiles,
  type CacheFile,
} from "../scripts/collect";
import type { StoredPullRequest } from "../src/lib/pr-store";
import { parseBackfillArguments } from "../scripts/backfill";

test("uses the configured timezone for edition dates and dated window ends", () => {
  assert.equal(dateInTimeZone(new Date("2026-08-31T22:30:00Z"), "Europe/Amsterdam"), "2026-09-01");
  assert.equal(endOfEditionDate("2026-08-31", "Europe/Amsterdam").toISOString(), "2026-08-31T21:59:59.999Z");
  assert.equal(endOfEditionDate("2026-12-31", "Europe/Amsterdam").toISOString(), "2026-12-31T22:59:59.999Z");
});

test("keeps the reporting window at exactly the configured number of hours across DST", () => {
  const window = reportingWindow(new Date("2026-10-26T20:00:00Z"), "2026-10-25", "Europe/Amsterdam", 24);
  assert.equal(window.editionDate, "2026-10-25");
  assert.equal(window.end.getTime() - window.start.getTime(), 24 * 60 * 60 * 1_000);
  assert.equal(window.end.toISOString(), "2026-10-25T22:59:59.999Z");
});

test("ends a requested current-date window at now and rejects future dates", () => {
  const now = new Date("2026-08-31T08:23:47.291Z");
  const window = reportingWindow(now, "2026-08-31", "Europe/Amsterdam", 24);
  assert.equal(window.editionDate, "2026-08-31");
  assert.equal(window.end.toISOString(), now.toISOString());
  assert.equal(window.start.toISOString(), "2026-08-30T08:23:47.291Z");
  assert.throws(
    () => reportingWindow(now, "2026-09-01", "Europe/Amsterdam", 24),
    /cannot be in the future/,
  );
});

test("validates requested edition dates and window lengths", () => {
  assert.throws(() => endOfEditionDate("2026-02-30", "Europe/Amsterdam"), /valid calendar date/);
  assert.throws(() => endOfEditionDate("August 31", "Europe/Amsterdam"), /YYYY-MM-DD/);
  assert.throws(() => reportingWindow(new Date(), undefined, "Europe/Amsterdam", 0), /positive number/);
});

test("extracts a useful summary after common pull request headings", () => {
  const body = "## Proposed change\n\nAdds local voice support for kitchens and hallways. More implementation detail follows.";
  assert.equal(sentenceSummary(body, "feat: fallback title"), "Adds local voice support for kitchens and hallways.");
  assert.equal(sentenceSummary("Short.", "feat(voice): Add a local wake word"), "Add a local wake word");
});

test("extracts safe HTTPS images from Markdown and HTML", () => {
  assert.equal(
    firstImage('![Dashboard](<https://github.com/user-attachments/assets/example?width=800&amp;height=600> "Preview")'),
    "https://github.com/user-attachments/assets/example?width=800&height=600",
  );
  assert.equal(firstImage('<p><img alt="Result" src="https://user-images.githubusercontent.com/example.png"></p>'), "https://user-images.githubusercontent.com/example.png");
  assert.equal(firstImage("![Nope](http://example.com/image.png)"), undefined);
  assert.equal(firstImage("![Nope](https://user:password@example.com/image.png)"), undefined);
  assert.deepEqual(
    extractMediaUrls("![One](https://example.com/one.png)\n<video src=\"https://example.com/two.mp4\"></video>"),
    ["https://example.com/one.png", "https://example.com/two.mp4"],
  );
});

test("only inspects PR file lists when the author signals visual media", () => {
  assert.equal(shouldInspectPullFiles("Add an energy widget", "## Screenshots\nSnapshot tests are attached."), true);
  assert.equal(shouldInspectPullFiles("Update snapshots", null), true);
  assert.equal(shouldInspectPullFiles("Fix an energy sensor", "Includes tests and documentation."), false);
});

test("builds SHA-pinned raw URLs for safe committed media", () => {
  const sha = "91bda3bd3a9df4281af6bf430207a6fe586cd0b7";
  assert.deepEqual(
    committedMediaUrls("home-assistant/iOS", sha, [
      { filename: "Tests/Widgets/__Snapshots__/energy light.png", status: "modified" },
      { filename: "Tests/Widgets/__Snapshots__/preview.webm", status: "added" },
      { filename: "Tests/Widgets/__Snapshots__/unsafe.svg", status: "added" },
      { filename: "Tests/Widgets/__Snapshots__/deleted.png", status: "removed" },
      { filename: "Tests/Widgets/__Snapshots__/energy light.png", status: "modified" },
    ]),
    [
      `https://raw.githubusercontent.com/home-assistant/iOS/${sha}/Tests/Widgets/__Snapshots__/energy%20light.png`,
      `https://raw.githubusercontent.com/home-assistant/iOS/${sha}/Tests/Widgets/__Snapshots__/preview.webm`,
    ],
  );
});

test("recovers the pinned head SHA from GitHub file metadata when old detail cache entries lack it", () => {
  const sha = "91bda3bd3a9df4281af6bf430207a6fe586cd0b7";
  assert.deepEqual(
    committedMediaUrls("home-assistant/iOS", undefined, [{
      filename: "Tests/Widgets/__Snapshots__/preview.png",
      status: "modified",
      raw_url: `https://github.com/home-assistant/iOS/raw/${sha}/Tests/Widgets/__Snapshots__/preview.png`,
    }]),
    [`https://raw.githubusercontent.com/home-assistant/iOS/${sha}/Tests/Widgets/__Snapshots__/preview.png`],
  );
});

test("credits human reviewers and approvers while excluding bots", () => {
  assert.deepEqual(
    reviewCredits([
      { state: "COMMENTED", submitted_at: "2026-08-20T10:00:00Z", user: { login: "ReviewerOne" } },
      { state: "APPROVED", submitted_at: "2026-08-20T11:00:00Z", user: { login: "Approver" } },
      { state: "APPROVED", submitted_at: "2026-08-20T12:00:00Z", user: { login: "dependabot[bot]" } },
      { state: "DISMISSED", submitted_at: "2026-08-20T13:00:00Z", user: { login: "Dismissed" } },
    ]),
    { reviewers: ["Approver", "ReviewerOne"], approvers: ["Approver"] },
  );
});

test("computes release-aware Project Pulse windows", () => {
  const base = {
    number: 1,
    url: "https://github.com/example/pull/1",
    repository: "home-assistant/core",
    organization: "Home Assistant",
    title: "Example",
    body: null,
    author: "author",
    mergedAt: "2026-08-31T10:00:00Z",
    labels: [],
    mediaUrls: [],
    reviewers: [],
    approvers: [],
    stats: {},
    isDependency: false,
    schemaVersion: 1 as const,
    revision: 1,
    firstSeenAt: "2026-08-31T10:00:00Z",
    storedAt: "2026-08-31T10:00:00Z",
  };
  const records: StoredPullRequest[] = [
    { ...base, id: 1 },
    { ...base, id: 2, mergedAt: "2026-08-10T10:00:00Z" },
    { ...base, id: 3, mergedAt: "2026-08-01T10:00:00Z" },
    { ...base, id: 4, repository: "music-assistant/server", organization: "Music Assistant", mergedAt: "2026-08-21T10:00:00Z" },
    { ...base, id: 5, repository: "esphome/esphome", organization: "ESPHome", mergedAt: "2026-08-20T10:00:00Z" },
  ];
  const cycles = [
    { product: "Home Assistant", rule: "first-wednesday" as const, beta_days_before: 7, release_offset_days: 0, accent: "blue" },
    { product: "ESPHome", rule: "first-wednesday" as const, beta_days_before: 7, release_offset_days: 14, accent: "green" },
  ];
  assert.equal(latestScheduledReleaseDate("2026-08-31", cycles[0]), "2026-08-05");
  const pulse = buildProjectPulse(
    records,
    new Date("2026-08-31T12:00:00Z"),
    "2026-08-31",
    "Europe/Amsterdam",
    cycles,
    { published_at: "2026-08-20T08:00:00Z", html_url: "https://github.com/music-assistant/server/releases/tag/1", tag_name: "1" },
  );
  assert.deepEqual(pulse, [
    { product: "Home Assistant", today: 1, thisWeek: 1, sinceRelease: 2, lastReleaseDate: "2026-08-05" },
    { product: "Music Assistant", today: 0, thisWeek: 0, sinceRelease: 1, lastReleaseDate: "2026-08-20" },
    { product: "ESPHome", today: 0, thisWeek: 0, sinceRelease: 1, lastReleaseDate: "2026-08-19" },
  ]);
});

test("uses authoritative GitHub totals for Project Pulse activity", async () => {
  const end = new Date("2026-08-31T12:00:00Z");
  const organizations = [
    { slug: "home-assistant", name: "Home Assistant", enabled: true, weight: 1, featured_repositories: [] },
    { slug: "music-assistant", name: "Music Assistant", enabled: true, weight: 1, featured_repositories: [] },
    { slug: "esphome", name: "ESPHome", enabled: true, weight: 1, featured_repositories: [] },
  ];
  const calls: Array<{ slug: string; start: string; end: string }> = [];
  const dailyTotals = new Map([
    ["home-assistant", 143],
    ["music-assistant", 15],
    ["esphome", 22],
  ]);
  const totals = new Map([
    ["home-assistant:2026-08-24T12:00:00.000Z", 1_095],
    ["music-assistant:2026-08-24T12:00:00.000Z", 275],
    ["esphome:2026-08-24T12:00:00.000Z", 183],
  ]);
  const cycles = [
    { product: "Home Assistant", rule: "first-wednesday" as const, beta_days_before: 7, release_offset_days: 0, accent: "blue" },
    { product: "ESPHome", rule: "first-wednesday" as const, beta_days_before: 7, release_offset_days: 14, accent: "green" },
  ];

  const pulse = await buildAuthoritativeProjectPulse(
    [],
    end,
    "2026-08-31",
    "Europe/Amsterdam",
    cycles,
    { published_at: "2026-08-20T08:00:00Z", html_url: "https://github.com/music-assistant/server/releases/tag/1", tag_name: "1" },
    organizations,
    dailyTotals,
    async (organization, start, queryEnd) => {
      calls.push({ slug: organization.slug, start: start.toISOString(), end: queryEnd.toISOString() });
      return totals.get(`${organization.slug}:${start.toISOString()}`) ?? 0;
    },
  );

  assert.deepEqual(pulse, [
    { product: "Home Assistant", today: 143, thisWeek: 1_095, sinceRelease: 0, lastReleaseDate: "2026-08-05" },
    { product: "Music Assistant", today: 15, thisWeek: 275, sinceRelease: 0, lastReleaseDate: "2026-08-20" },
    { product: "ESPHome", today: 22, thisWeek: 183, sinceRelease: 0, lastReleaseDate: "2026-08-19" },
  ]);
  assert.equal(calls.length, 3);
  assert.ok(calls.every((call) => call.end === end.toISOString()));
});

test("builds Release Radar items from GitHub releases inside the reporting window", () => {
  const releases = landedReleasesFromHistory(
    { repository: "esphome/esphome", product: "ESPHome", accent: "green", include_prereleases: false },
    [
      { id: 10, name: "2026.8.2", body: null, published_at: "2026-08-31T02:22:48Z", html_url: "https://github.com/esphome/esphome/releases/tag/2026.8.2", tag_name: "2026.8.2" },
      { id: 11, name: "2026.9.0b1", body: null, published_at: "2026-08-31T03:00:00Z", html_url: "https://github.com/esphome/esphome/releases/tag/2026.9.0b1", tag_name: "2026.9.0b1", prerelease: true },
      { id: 12, name: "Draft", body: null, published_at: "2026-08-31T04:00:00Z", html_url: "https://github.com/esphome/esphome/releases/tag/draft", tag_name: "draft", draft: true },
      { id: 13, name: "Too old", body: null, published_at: "2026-08-30T20:00:00Z", html_url: "https://github.com/esphome/esphome/releases/tag/old", tag_name: "old" },
    ],
    new Date("2026-08-30T21:59:59Z"),
    new Date("2026-08-31T21:59:59Z"),
    [{
      id: "99",
      title: "2026.8.2",
      summary: "Release merge",
      url: "https://github.com/esphome/esphome/pull/99",
      repository: "esphome/esphome",
      organization: "ESPHome",
      author: "release-manager",
      mergedAt: "2026-08-31T02:22:43Z",
      labels: ["merging-to-release"],
      kind: "platform",
      score: 40,
    }],
  );

  assert.deepEqual(releases, [{
    id: "esphome/esphome:10",
    product: "ESPHome",
    repository: "esphome/esphome",
    name: "2026.8.2",
    tag: "2026.8.2",
    url: "https://github.com/esphome/esphome/releases/tag/2026.8.2",
    publishedAt: "2026-08-31T02:22:48Z",
    channel: "stable",
    accent: "green",
    sourcePullRequestIds: ["99"],
  }]);
});

test("creates preview targets only for scheduled stable releases on the edition date", () => {
  assert.deepEqual(releaseTargetsForDate("2026-09-02", [
    { product: "Home Assistant", kind: "Beta", date: "2026-08-26", accent: "blue" },
    { product: "Home Assistant", kind: "Release", date: "2026-09-02", accent: "blue" },
    { product: "ESPHome", kind: "Release", date: "2026-09-16", accent: "green" },
  ]), [{ product: "Home Assistant", version: "2026.9", releaseDate: "2026-09-02" }]);
});

test("warms release previews throughout beta week without treating beta day as release day", () => {
  const releases = [
    { product: "Home Assistant", kind: "Beta" as const, date: "2026-08-26", accent: "blue" },
    { product: "Home Assistant", kind: "Release" as const, date: "2026-09-02", accent: "blue" },
    { product: "ESPHome", kind: "Release" as const, date: "2026-09-16", accent: "green" },
  ];
  const cycles = [
    { product: "Home Assistant", rule: "first-wednesday" as const, beta_days_before: 7, release_offset_days: 0, accent: "blue" },
    { product: "ESPHome", rule: "first-wednesday" as const, beta_days_before: 7, release_offset_days: 14, accent: "green" },
  ];
  assert.deepEqual(releasePreviewTargetsForDate("2026-08-31", releases, cycles), [
    { product: "Home Assistant", version: "2026.9", releaseDate: "2026-09-02" },
  ]);
  assert.deepEqual(releaseTargetsForDate("2026-08-31", releases), []);
  assert.deepEqual(releasePreviewTargetsForDate("2026-08-25", releases, cycles), []);
});

test("parses inclusive history-only backfill bounds", () => {
  assert.deepEqual(parseBackfillArguments(["--from", "2026-08-01", "--to", "2026-08-31"]), { from: "2026-08-01", to: "2026-08-31" });
  assert.throws(() => parseBackfillArguments(["--from", "2026-08-01"]), /Both --from and --to/);
});

test("backfills an inclusive range newest first", () => {
  assert.deepEqual(backfillDatesNewestFirst("2026-08-29", "2026-08-31", "Europe/Amsterdam"), [
    "2026-08-31",
    "2026-08-30",
    "2026-08-29",
  ]);
  assert.deepEqual(backfillDatesNewestFirst("2026-08-31", "2026-08-31", "Europe/Amsterdam"), ["2026-08-31"]);
  assert.throws(() => backfillDatesNewestFirst("2026-09-01", "2026-08-31", "Europe/Amsterdam"), /on or before/);
});

test("classifies editorial categories from titles and labels", () => {
  assert.equal(classify("Support a new local device", []), "feature");
  assert.equal(classify("Avoid crash during startup", []), "fix");
  assert.equal(classify("Update wording", ["Documentation"]), "docs");
  assert.equal(classify("Refresh toolchain", ["CI"]), "maintenance");
  assert.equal(classify("Rework platform ownership", []), "platform");
  assert.equal(classify("Move coordinator ownership", []), "platform");
});

test("serves fresh cache entries without making a request", async () => {
  const cache: CacheFile = {
    version: 1,
    entries: { "https://api.github.test/value": { fetchedAt: "2026-08-31T12:00:00Z", data: { cached: true } } },
  };
  let requests = 0;
  const fetcher = (async () => {
    requests += 1;
    throw new Error("should not fetch");
  }) as typeof fetch;
  const client = new GitHubClient(cache, fetcher, () => new Date("2026-08-31T12:05:00Z"));
  assert.deepEqual(await client.get("https://api.github.test/value", { maxAgeMinutes: 30 }), { cached: true });
  assert.equal(requests, 0);
});

test("revalidates stale entries with ETags and refreshes their cache time", async () => {
  const url = "https://api.github.test/value";
  const cache: CacheFile = {
    version: 1,
    entries: { [url]: { fetchedAt: "2026-08-30T12:00:00Z", etag: '"abc"', data: { cached: true } } },
  };
  let conditionalHeader: string | null = null;
  const fetcher = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    conditionalHeader = new Headers(init?.headers).get("if-none-match");
    return new Response(null, { status: 304 });
  }) as typeof fetch;
  const client = new GitHubClient(cache, fetcher, () => new Date("2026-08-31T13:00:00Z"));
  assert.deepEqual(await client.get(url, { maxAgeMinutes: 30 }), { cached: true });
  assert.equal(conditionalHeader, '"abc"');
  assert.equal(cache.entries[url].fetchedAt, "2026-08-31T13:00:00.000Z");
});

test("uses stale cache data when GitHub returns an error", async () => {
  const url = "https://api.github.test/value";
  const cache: CacheFile = {
    version: 1,
    entries: { [url]: { fetchedAt: "2026-08-01T12:00:00Z", data: { cached: true } } },
  };
  const fetcher = (async () => new Response("rate limited", { status: 403 })) as typeof fetch;
  const client = new GitHubClient(cache, fetcher, () => new Date("2026-08-31T13:00:00Z"));
  assert.deepEqual(await client.get(url, { maxAgeMinutes: 30 }), { cached: true });
});
