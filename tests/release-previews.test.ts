import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { collectReleasePreviews, releasePreviewInternals } from "../src/lib/release-previews";

async function temporaryRoot(): Promise<string> {
  return mkdtemp(resolve(tmpdir(), "ohf-release-previews-"));
}

const directPage = `<!doctype html><html><head>
  <title>Fallback title</title>
  <meta property="og:title" content="Home Assistant 2026.9 beta">
  <meta property="og:image" content="/images/release-card.jpg">
</head><body><nav>Skip navigation</nav><main>
  <h1>Home Assistant 2026.9</h1><p>A clearer dashboard for every home.</p>
  <img src="media/dashboard.webp"><img src="http://example.com/unsafe.jpg">
</main><footer>Skip footer</footer></body></html>`;

test("collects a direct official preview with bounded readable content and resolved media", async (context) => {
  const root = await temporaryRoot();
  context.after(() => rm(root, { recursive: true, force: true }));
  const result = await collectReleasePreviews({
    root,
    sources: [{ product: "Home Assistant", url: "https://example.com/beta", max_chars: 45 }],
    targets: [{ product: "Home Assistant", version: "2026.9", releaseDate: "2026-09-02" }],
    now: () => new Date("2026-08-31T12:00:00Z"),
    fetcher: (async () => new Response(directPage, {
      status: 200,
      headers: { "content-type": "text/html", etag: '"preview-v1"', "last-modified": "Mon, 31 Aug 2026 10:00:00 GMT" },
    })) as typeof fetch,
  });

  assert.deepEqual(result.warnings, []);
  assert.equal(result.previews.length, 1);
  const [{ contentHash, ...preview }] = result.previews;
  assert.match(contentHash, /^[a-f0-9]{64}$/);
  assert.deepEqual(preview, {
      id: "Home Assistant/2026.9",
      product: "Home Assistant",
      version: "2026.9",
      title: "Home Assistant 2026.9 beta",
      url: "https://example.com/beta",
      body: "Home Assistant 2026.9\nA clearer dashboard fo…",
      mediaUrls: [
        "https://example.com/images/release-card.jpg",
        "https://example.com/media/dashboard.webp",
      ],
      fetchedAt: "2026-08-31T12:00:00.000Z",
      releaseDate: "2026-09-02T00:00:00.000Z",
  });
  const cache = JSON.parse(await readFile(resolve(root, "data/cache/release-previews.json"), "utf8"));
  assert.equal(Object.values(cache.entries).length, 1);
});

test("discovers a versioned article from an index and collects targets in parallel", async (context) => {
  const root = await temporaryRoot();
  context.after(() => rm(root, { recursive: true, force: true }));
  const started: string[] = [];
  const fetcher = (async (input: string | URL | Request): Promise<Response> => {
    const url = String(input);
    started.push(url);
    if (url.endsWith("/releases")) {
      const product = url.includes("one.example") ? "one" : "two";
      return new Response(`<main><a href="/blog/release-20269">${product}</a><a href="http://unsafe.example/release-20269">unsafe</a></main>`, {
        status: 200,
        headers: { "content-type": "text/html" },
      });
    }
    return new Response(`<article><h1>Release details</h1><p>${url}</p></article>`, {
      status: 200,
      headers: { "content-type": "text/html" },
    });
  }) as typeof fetch;
  const result = await collectReleasePreviews({
    root,
    sources: [
      { product: "One", url: "https://one.example/releases", article_link_pattern: "/blog/release-{version_compact}" },
      { product: "Two", url: "https://two.example/releases", article_link_pattern: "/blog/release-{version_compact}" },
    ],
    targets: [
      { product: "One", version: "2026.9", releaseDate: "2026-09-02T12:00:00Z" },
      { product: "Two", version: "2026.9", releaseDate: "2026-09-03T12:00:00Z" },
    ],
    fetcher,
  });

  assert.equal(result.previews.length, 2);
  assert.deepEqual(started.slice(0, 2), ["https://one.example/releases", "https://two.example/releases"]);
  assert.equal(result.previews[0].url, "https://one.example/blog/release-20269");
  assert.equal(result.previews[1].url, "https://two.example/blog/release-20269");
});

test("sends conditional cache headers and reuses cached content after 304", async (context) => {
  const root = await temporaryRoot();
  context.after(() => rm(root, { recursive: true, force: true }));
  let request = 0;
  const fetcher = (async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    request += 1;
    if (request === 1) return new Response("<main><p>Cached preview.</p></main>", {
      status: 200,
      headers: { "content-type": "text/html", etag: '"release"', "last-modified": "Mon, 31 Aug 2026 10:00:00 GMT" },
    });
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("if-none-match"), '"release"');
    assert.equal(headers.get("if-modified-since"), "Mon, 31 Aug 2026 10:00:00 GMT");
    return new Response(null, { status: 304 });
  }) as typeof fetch;
  const options = {
    root,
    sources: [{ product: "ESPHome", url: "https://example.com/release" }],
    targets: [{ product: "ESPHome", version: "2026.9", releaseDate: "2026-09-16" }],
    fetcher,
  };
  await collectReleasePreviews({ ...options, now: () => new Date("2026-08-31T10:00:00Z") });
  const result = await collectReleasePreviews({ ...options, now: () => new Date("2026-08-31T11:00:00Z") });
  assert.equal(result.previews[0].body, "Cached preview.");
  assert.equal(result.previews[0].fetchedAt, "2026-08-31T11:00:00.000Z");
  assert.deepEqual(result.warnings, []);
});

test("uses Home Assistant RC metadata and Atom content only when version and date match", async (context) => {
  const root = await temporaryRoot();
  context.after(() => rm(root, { recursive: true, force: true }));
  const metadata = "current_major_version: 2026\ncurrent_minor_version: 9\ndate_released: 2026-09-02\n";
  const atom = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom">
    <entry><id>mention</id><title>A different post mentioning 2026.9</title><updated>2026-08-31T01:00:00Z</updated><link href="https://example.com/blog/mention/"/><content>Read about 2026.9 at release-20269.</content></entry>
    <entry><id>old</id><title>Home Assistant 2026.8</title><updated>2026-08-01T00:00:00Z</updated><link href="https://www.home-assistant.io/blog/2026/08/01/release-20268/"/><content>Old release.</content></entry>
    <entry><id>new</id><title>Home Assistant 2026.9: A useful beta</title><updated>2026-08-31T00:00:00Z</updated><link href="https://www.home-assistant.io/blog/2026/09/02/release-20269/"/><content><![CDATA[<p>New dashboards and devices.</p><img src="/images/blog/new.png">]]></content></entry>
  </feed>`;
  const result = await collectReleasePreviews({
    root,
    sources: [{
      product: "Home Assistant",
      strategy: "home_assistant_rc",
      metadata_url: "https://raw.githubusercontent.com/home-assistant/home-assistant.io/rc/_config.yml",
      feed_url: "https://rc.home-assistant.io/atom.xml",
    }],
    targets: [{ product: "Home Assistant", version: "2026.9", releaseDate: "2026-09-02" }],
    fetcher: (async (input) => {
      const url = String(input);
      if (url.endsWith("_config.yml")) return new Response(metadata, { status: 200, headers: { "content-type": "text/plain" } });
      if (url.endsWith("atom.xml")) return new Response(atom, { status: 200, headers: { "content-type": "application/atom+xml" } });
      return new Response("<main><h1>Home Assistant 2026.9: A useful beta</h1><p>New dashboards and devices.</p><img src=\"/images/blog/new.png\"></main>", {
        status: 200,
        headers: { "content-type": "text/html" },
      });
    }) as typeof fetch,
  });
  assert.equal(result.previews.length, 1);
  assert.equal(result.previews[0].title, "Home Assistant 2026.9: A useful beta");
  assert.equal(result.previews[0].url, "https://rc.home-assistant.io/blog/2026/09/02/release-20269/");
  assert.equal(result.previews[0].body, "Home Assistant 2026.9: A useful beta\nNew dashboards and devices.");
  assert.deepEqual(result.previews[0].mediaUrls, ["https://rc.home-assistant.io/images/blog/new.png"]);
});

test("rejects Home Assistant RC metadata that does not match the active target", async (context) => {
  const root = await temporaryRoot();
  context.after(() => rm(root, { recursive: true, force: true }));
  const result = await collectReleasePreviews({
    root,
    sources: [{
      product: "Home Assistant",
      strategy: "home_assistant_rc",
      metadata_url: "https://raw.githubusercontent.com/home-assistant/home-assistant.io/rc/_config.yml",
      feed_url: "https://rc.home-assistant.io/atom.xml",
    }],
    targets: [{ product: "Home Assistant", version: "2026.9", releaseDate: "2026-09-02" }],
    fetcher: (async (input) => String(input).endsWith("_config.yml")
      ? new Response("current_major_version: 2026\ncurrent_minor_version: 8\ndate_released: 2026-09-02", { status: 200 })
      : new Response("<feed xmlns=\"http://www.w3.org/2005/Atom\"></feed>", { status: 200 })) as typeof fetch,
  });
  assert.deepEqual(result.previews, []);
  assert.match(result.warnings[0], /version 2026\.8 does not match 2026\.9/);
});

test("uses ESPHome Next metadata to verify the version and resolve its preview blog", async (context) => {
  const root = await temporaryRoot();
  context.after(() => rm(root, { recursive: true, force: true }));
  const fetched: string[] = [];
  const result = await collectReleasePreviews({
    root,
    sources: [{
      product: "ESPHome",
      strategy: "esphome_next",
      metadata_url: "https://raw.githubusercontent.com/esphome/esphome.io/next/data/version.json",
    }],
    targets: [{ product: "ESPHome", version: "2026.9", releaseDate: "2026-09-16" }],
    fetcher: (async (input) => {
      const url = String(input);
      fetched.push(url);
      return url.includes("version.json")
        ? new Response(JSON.stringify({ version: "2026.9.0", blog_url: "/changelog/2026.9.0/" }), { status: 200, headers: { "content-type": "application/json" } })
        : new Response("<article><h1>ESPHome 2026.9</h1><p>New component previews.</p></article>", { status: 200, headers: { "content-type": "text/html" } });
    }) as typeof fetch,
  });
  assert.deepEqual(fetched, [
    "https://raw.githubusercontent.com/esphome/esphome.io/next/data/version.json",
    "https://next.esphome.io/changelog/2026.9.0/",
  ]);
  assert.equal(result.previews[0].url, "https://next.esphome.io/changelog/2026.9.0/");
  assert.equal(result.previews[0].body, "ESPHome 2026.9\nNew component previews.");
});

test("uses stale cached content after a refresh failure and reports a warning", async (context) => {
  const root = await temporaryRoot();
  context.after(() => rm(root, { recursive: true, force: true }));
  let available = true;
  const options = {
    root,
    sources: [{ product: "Music Assistant", url: "https://example.com/preview" }],
    targets: [{ product: "Music Assistant", version: "2.7", releaseDate: "2026-09-10" }],
    fetcher: (async (): Promise<Response> => {
      if (!available) throw new Error("offline");
      return new Response("<article><p>Preview survives.</p></article>", { status: 200, headers: { "content-type": "text/html" } });
    }) as typeof fetch,
  };
  await collectReleasePreviews({ ...options, now: () => new Date("2026-08-30T12:00:00Z") });
  available = false;
  const result = await collectReleasePreviews({ ...options, now: () => new Date("2026-08-31T12:00:00Z") });
  assert.equal(result.previews[0].body, "Preview survives.");
  assert.equal(result.previews[0].fetchedAt, "2026-08-30T12:00:00.000Z");
  assert.match(result.warnings[0], /cached release preview data/);
});

test("fails soft per source for unsafe URLs, missing links, oversized pages, and invalid targets", async (context) => {
  const root = await temporaryRoot();
  context.after(() => rm(root, { recursive: true, force: true }));
  const result = await collectReleasePreviews({
    root,
    sources: [
      { product: "Unsafe", url: "http://example.com/preview" },
      { product: "Missing", url: "https://example.com/index", article_link_pattern: "/release/{version}" },
      { product: "Large", url: "https://example.com/large" },
      { product: "Disabled", url: "https://example.com/disabled", enabled: false },
    ],
    targets: [
      { product: "Unsafe", version: "1", releaseDate: "2026-09-01" },
      { product: "Missing", version: "1", releaseDate: "2026-09-01" },
      { product: "Large", version: "1", releaseDate: "2026-09-01" },
      { product: "Disabled", version: "1", releaseDate: "2026-09-01" },
      { product: "Broken", version: "1", releaseDate: "not-a-date" },
    ],
    maxResponseBytes: 32,
    fetcher: (async (input) => String(input).endsWith("/large")
      ? new Response("x".repeat(33), { status: 200, headers: { "content-type": "text/html" } })
      : new Response("<main>No matching anchor.</main>", { status: 200, headers: { "content-type": "text/html" } })) as typeof fetch,
  });

  assert.deepEqual(result.previews, []);
  assert.equal(result.warnings.length, 5);
  assert.match(result.warnings.join("\n"), /credential-free HTTPS/);
  assert.match(result.warnings.join("\n"), /no link matched/);
  assert.match(result.warnings.join("\n"), /exceeds 32 bytes/);
  assert.match(result.warnings.join("\n"), /invalid release date/);
  assert.match(result.warnings.join("\n"), /No enabled release preview source is configured for Disabled/);
});

test("internal helpers reject credentials and resolve only safe HTTPS media", () => {
  assert.throws(() => releasePreviewInternals.publicHttpsUrl("https://user:pass@example.com/private"), /credential-free HTTPS/);
  assert.deepEqual(
    releasePreviewInternals.pageMediaUrls('<article><img src="/one.png"><img src="javascript:bad"><video poster="https://cdn.example/two.webp"></video></article>', "https://example.com/release"),
    ["https://example.com/one.png", "https://cdn.example/two.webp"],
  );
});
