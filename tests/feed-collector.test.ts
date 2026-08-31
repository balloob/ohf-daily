import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { collectContentFeeds, feedCollectorInternals, googleAlertSources } from "../src/lib/feed-collector";

const rss = `<?xml version="1.0"?><rss version="2.0"><channel><title>News</title><item><guid>story-1</guid><title>One useful announcement</title><link>https://example.com/news/one</link><pubDate>Mon, 31 Aug 2026 08:30:00 GMT</pubDate><description>Official details.</description></item></channel></rss>`;

async function temporaryRoot(): Promise<string> {
  return mkdtemp(resolve(tmpdir(), "ohf-feed-collector-"));
}

test("collects, caches, archives, and selects official feed entries in the reporting window", async (context) => {
  const root = await temporaryRoot();
  context.after(() => rm(root, { recursive: true, force: true }));
  const calls: Array<Record<string, string>> = [];
  const fetcher = async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    calls.push(Object.fromEntries(new Headers(init?.headers).entries()));
    return new Response(rss, { status: 200, headers: { "content-type": "application/rss+xml", etag: '"v1"' } });
  };
  const result = await collectContentFeeds({
    root,
    sources: [{ id: "official-news", name: "Official News", kind: "official", url: "https://example.com/rss.xml" }],
    start: new Date("2026-08-31T00:00:00Z"),
    end: new Date("2026-09-01T00:00:00Z"),
    fetcher: fetcher as typeof fetch,
    now: () => new Date("2026-08-31T12:00:00Z"),
  });
  assert.equal(result.written, 1);
  assert.equal(result.current.length, 1);
  assert.equal(result.current[0].kind, "official_post");
  assert.match(result.current[0].id, /^official-news:[a-f0-9]{24}$/);
  assert.equal(calls.length, 1);
  const cache = JSON.parse(await readFile(resolve(root, "data/cache/feeds.json"), "utf8"));
  assert.equal(cache.entries["official-news"].etag, '"v1"');
});

test("collects official news pages discovered through a filtered sitemap", async (context) => {
  const root = await temporaryRoot();
  context.after(() => rm(root, { recursive: true, force: true }));
  const sitemap = `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
    <url><loc>https://www.nabucasa.com/news/</loc><lastmod>2026-08-31</lastmod></url>
    <url><loc>https://www.nabucasa.com/news/2026-08-31-new-thing/</loc><lastmod>2026-08-31</lastmod></url>
    <url><loc>https://www.nabucasa.com/about/</loc><lastmod>2026-08-31</lastmod></url>
  </urlset>`;
  const article = `<!doctype html><html><head>
    <meta property="og:title" content="A useful Nabu Casa announcement">
    <meta name="description" content="Canonical details from the official news page.">
    <meta property="article:published_time" content="2026-08-31T09:30:00Z">
    <meta property="og:image" content="/images/announcement.jpg">
  </head><body></body></html>`;
  const fetched: string[] = [];
  const result = await collectContentFeeds({
    root,
    sources: [{
      id: "nabu-casa-news",
      name: "Nabu Casa News",
      kind: "official",
      format: "sitemap",
      path_prefix: "/news/",
      url: "https://www.nabucasa.com/sitemap.xml",
    }],
    start: new Date("2026-08-31T00:00:00Z"),
    end: new Date("2026-09-01T00:00:00Z"),
    fetcher: (async (input) => {
      const url = String(input);
      fetched.push(url);
      return url.endsWith("sitemap.xml")
        ? new Response(sitemap, { status: 200, headers: { "content-type": "application/xml" } })
        : new Response(article, { status: 200, headers: { "content-type": "text/html" } });
    }) as typeof fetch,
  });
  assert.deepEqual(fetched, [
    "https://www.nabucasa.com/sitemap.xml",
    "https://www.nabucasa.com/news/2026-08-31-new-thing/",
  ]);
  assert.equal(result.current.length, 1);
  assert.equal(result.current[0].kind, "official_post");
  assert.equal(result.current[0].source, "Nabu Casa News");
  assert.equal(result.current[0].title, "A useful Nabu Casa announcement");
  assert.equal(result.current[0].body, "Canonical details from the official news page.");
  assert.deepEqual(result.current[0].mediaUrls, ["https://www.nabucasa.com/images/announcement.jpg"]);
});

test("revalidates with ETag and reuses cached XML after a 304", async (context) => {
  const root = await temporaryRoot();
  context.after(() => rm(root, { recursive: true, force: true }));
  let request = 0;
  const fetcher = async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    request += 1;
    if (request === 1) return new Response(rss, { status: 200, headers: { "content-type": "application/xml", etag: '"feed"' } });
    assert.equal(new Headers(init?.headers).get("if-none-match"), '"feed"');
    return new Response(null, { status: 304 });
  };
  const options = {
    root,
    sources: [{ id: "official-news", name: "Official News", kind: "official" as const, url: "https://example.com/rss.xml" }],
    start: new Date("2026-08-31T00:00:00Z"),
    end: new Date("2026-09-01T00:00:00Z"),
    fetcher: fetcher as typeof fetch,
  };
  await collectContentFeeds(options);
  const second = await collectContentFeeds(options);
  assert.equal(second.current.length, 1);
  assert.equal(second.written, 0);
  assert.equal(second.unchanged, 1);
});

test("fails soft for a missing secret feed and accepts many private Google Alert feeds from JSON", async (context) => {
  const root = await temporaryRoot();
  context.after(() => rm(root, { recursive: true, force: true }));
  const result = await collectContentFeeds({
    root,
    sources: [{ id: "private-alert", name: "Private alert", kind: "google_alert", url_env: "MISSING_ALERT" }],
    start: new Date("2026-08-31T00:00:00Z"),
    end: new Date("2026-09-01T00:00:00Z"),
    environment: {},
    fetcher: (() => { throw new Error("must not fetch"); }) as typeof fetch,
  });
  assert.equal(result.configured, 0);
  assert.match(result.warnings[0], /MISSING_ALERT/);

  assert.deepEqual(googleAlertSources(JSON.stringify([{
    id: "open-home-mentions",
    name: "Open Home mentions",
    url: "https://www.google.com/alerts/feeds/123/456",
  }])), [{
    id: "open-home-mentions",
    name: "Open Home mentions",
    url: "https://www.google.com/alerts/feeds/123/456",
    kind: "google_alert",
    desk: "External coverage",
  }]);
  assert.throws(() => feedCollectorInternals.safeFeedUrl("https://news.google.com/rss/search?q=ohf", "google_alert"), /Google Alert/);
});

test("keeps valid Google Alert entries when another entry is malformed", () => {
  const warnings: string[] = [];
  const sources = googleAlertSources(JSON.stringify([
    { id: "good-alert", name: "Good alert", url: "https://www.google.com/alerts/feeds/123/456" },
    { id: "bad-alert", name: "Missing URL" },
  ]), warnings);
  assert.equal(sources.length, 1);
  assert.equal(sources[0].id, "good-alert");
  assert.match(warnings[0], /feed 2/);
});

test("a malformed Google Alerts setting does not stop official feeds", async (context) => {
  const root = await temporaryRoot();
  context.after(() => rm(root, { recursive: true, force: true }));
  const result = await collectContentFeeds({
    root,
    sources: [{ id: "official-news", name: "Official News", kind: "official", url: "https://example.com/rss.xml" }],
    start: new Date("2026-08-31T00:00:00Z"),
    end: new Date("2026-09-01T00:00:00Z"),
    environment: { GOOGLE_ALERT_FEEDS_JSON: "not JSON" },
    fetcher: (async () => new Response(rss, { status: 200, headers: { "content-type": "application/rss+xml" } })) as typeof fetch,
  });
  assert.equal(result.configured, 1);
  assert.equal(result.current.length, 1);
  assert.match(result.warnings[0], /valid JSON/);
});

test("uses cached feed data after a transient refresh failure", async (context) => {
  const root = await temporaryRoot();
  context.after(() => rm(root, { recursive: true, force: true }));
  let available = true;
  const fetcher = async (): Promise<Response> => {
    if (!available) throw new Error("offline");
    return new Response(rss, { status: 200, headers: { "content-type": "application/atom+xml" } });
  };
  const options = {
    root,
    sources: [{ id: "official-news", name: "Official News", kind: "official" as const, url: "https://example.com/rss.xml" }],
    start: new Date("2026-08-31T00:00:00Z"),
    end: new Date("2026-09-01T00:00:00Z"),
    fetcher: fetcher as typeof fetch,
  };
  await collectContentFeeds(options);
  available = false;
  const result = await collectContentFeeds(options);
  assert.equal(result.current.length, 1);
  assert.match(result.warnings[0], /cached feed data/);
});

test("does not share cached XML between duplicate or changed feed identities", async (context) => {
  const root = await temporaryRoot();
  context.after(() => rm(root, { recursive: true, force: true }));
  const first = await collectContentFeeds({
    root,
    sources: [
      { id: "same-id", name: "Official", kind: "official", url: "https://example.com/one.xml" },
      { id: "same-id", name: "Alert", kind: "google_alert", url: "https://www.google.com/alerts/feeds/123/456" },
    ],
    start: new Date("2026-08-31T00:00:00Z"),
    end: new Date("2026-09-01T00:00:00Z"),
    fetcher: (async () => new Response(rss, { status: 200, headers: { "content-type": "application/rss+xml", etag: '"one"' } })) as typeof fetch,
  });
  assert.equal(first.configured, 1);
  assert.match(first.warnings[0], /duplicated/);

  let conditionalHeader: string | null = "not called";
  await collectContentFeeds({
    root,
    sources: [{ id: "same-id", name: "Changed", kind: "official", url: "https://example.com/two.xml" }],
    start: new Date("2026-08-31T00:00:00Z"),
    end: new Date("2026-09-01T00:00:00Z"),
    fetcher: (async (_url, init) => {
      conditionalHeader = new Headers(init?.headers).get("if-none-match");
      return new Response(rss, { status: 200, headers: { "content-type": "application/rss+xml" } });
    }) as typeof fetch,
  });
  assert.equal(conditionalHeader, null);
});

test("unwraps Google Alert redirect links and records the publisher domain", async (context) => {
  const root = await temporaryRoot();
  context.after(() => rm(root, { recursive: true, force: true }));
  const alertRss = rss.replace("https://example.com/news/one", "https://www.google.com/url?url=https%3A%2F%2Fpublisher.example%2Fstory%3Futm_source%3Dalerts");
  const result = await collectContentFeeds({
    root,
    sources: [{ id: "news-alert", name: "News alert", kind: "google_alert", url: "https://www.google.com/alerts/feeds/123/456" }],
    start: new Date("2026-08-31T00:00:00Z"),
    end: new Date("2026-09-01T00:00:00Z"),
    fetcher: (async () => new Response(alertRss, { status: 200, headers: { "content-type": "application/rss+xml" } })) as typeof fetch,
  });
  assert.equal(result.current[0].url, "https://publisher.example/story?utm_source=alerts");
  assert.equal(result.current[0].source, "publisher.example");
});
