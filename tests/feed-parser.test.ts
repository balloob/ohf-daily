import assert from "node:assert/strict";
import test from "node:test";
import { feedParserInternals, parseFeed, parseSitemap } from "../src/lib/feed-parser";

test("normalizes RSS 2.0 CDATA, namespaces, enclosures, and canonical URLs", () => {
  const entries = parseFeed(`<?xml version="1.0" encoding="UTF-8"?>
    <rss version="2.0"
      xmlns:content="http://purl.org/rss/1.0/modules/content/"
      xmlns:dc="http://purl.org/dc/elements/1.1/"
      xmlns:media="http://search.yahoo.com/mrss/">
      <channel>
        <title>Example feed</title>
        <item>
          <guid isPermaLink="false">post-42</guid>
          <title><![CDATA[A <strong>safer</strong> &amp; clearer home]]></title>
          <link>https://Example.com/posts/42?utm_source=rss&amp;b=2&amp;a=1#section</link>
          <pubDate>Mon, 31 Aug 2026 08:30:00 GMT</pubDate>
          <dc:creator><![CDATA[Example&nbsp;Author]]></dc:creator>
          <description><![CDATA[<p>Hello&nbsp;<strong>world</strong> &amp; friends.</p><script>ignore me</script>]]></description>
          <content:encoded><![CDATA[<p>Full body.</p><p>Second line.</p><img src="https://cdn.example.com/hero.png?x=1&amp;y=2" />]]></content:encoded>
          <enclosure url="https://cdn.example.com/demo.mp4" type="video/mp4" />
          <enclosure url="https://cdn.example.com/notes.pdf" type="application/pdf" />
          <media:thumbnail url="https://cdn.example.com/thumb.webp" />
          <media:content url="http://cdn.example.com/unsafe.jpg" medium="image" />
        </item>
      </channel>
    </rss>`);

  assert.deepEqual(entries, [{
    guid: "post-42",
    title: "A safer & clearer home",
    url: "https://example.com/posts/42?a=1&b=2",
    publishedAt: "2026-08-31T08:30:00.000Z",
    author: "Example Author",
    summary: "Hello world & friends.",
    content: "Full body.\nSecond line.",
    mediaUrls: [
      "https://cdn.example.com/demo.mp4",
      "https://cdn.example.com/thumb.webp",
      "https://cdn.example.com/hero.png?x=1&y=2",
    ],
  }]);
});

test("normalizes Atom links, dates, authors, HTML, and media namespaces", () => {
  const entries = parseFeed(`<?xml version="1.0"?>
    <feed xmlns="http://www.w3.org/2005/Atom" xmlns:media="http://search.yahoo.com/mrss/">
      <title>Example Atom</title>
      <entry>
        <id>tag:example.com,2026:one</id>
        <title type="html">Matter &amp;amp; more</title>
        <published>2026-08-30T07:00:00+02:00</published>
        <updated>2026-08-31T08:00:00+02:00</updated>
        <author><name>Jane Example</name></author>
        <link rel="self" href="https://example.com/feed/one" />
        <link rel="alternate" type="text/html" href="https://EXAMPLE.com/one?utm_medium=feed&amp;z=9" />
        <link rel="enclosure" type="image/jpeg" href="https://media.example.com/one.jpg" />
        <summary type="html">&lt;p&gt;Short &lt;em&gt;summary&lt;/em&gt;.&lt;/p&gt;</summary>
        <content type="xhtml"><div xmlns="http://www.w3.org/1999/xhtml"><p>Full Atom body.</p></div></content>
        <media:content url="https://media.example.com/clip.webm" medium="video" />
      </entry>
      <entry>
        <id>unsafe</id>
        <title>Unsafe link</title>
        <updated>2026-08-31T08:00:00Z</updated>
        <link href="http://example.com/not-https" />
      </entry>
    </feed>`);

  assert.deepEqual(entries, [{
    guid: "tag:example.com,2026:one",
    title: "Matter & more",
    url: "https://example.com/one?z=9",
    publishedAt: "2026-08-30T05:00:00.000Z",
    updatedAt: "2026-08-31T06:00:00.000Z",
    author: "Jane Example",
    summary: "Short summary.",
    content: "Full Atom body.",
    mediaUrls: [
      "https://media.example.com/one.jpg",
      "https://media.example.com/clip.webm",
    ],
  }]);
});

test("uses updated as an Atom publication date and a safe permalink GUID as an RSS URL", () => {
  const atom = parseFeed(`<feed xmlns="http://www.w3.org/2005/Atom"><entry><id>one</id><title>One</title><updated>2026-08-31T01:02:03Z</updated><link href="https://example.com/one" /></entry></feed>`);
  assert.equal(atom[0].publishedAt, "2026-08-31T01:02:03.000Z");
  assert.equal(atom[0].updatedAt, undefined);

  const rss = parseFeed(`<rss version="2.0"><channel><item><guid>https://example.com/two?utm_source=feed</guid><title>Two</title><pubDate>2026-08-31T02:00:00Z</pubDate></item></channel></rss>`);
  assert.equal(rss[0].url, "https://example.com/two");
  assert.equal(rss[0].guid, "https://example.com/two?utm_source=feed");
});

test("accepts explicitly prefixed Atom elements", () => {
  const entries = parseFeed(`<atom:feed xmlns:atom="http://www.w3.org/2005/Atom">
    <atom:entry>
      <atom:id>prefixed</atom:id>
      <atom:title>Prefixed Atom</atom:title>
      <atom:published>2026-08-31T03:00:00Z</atom:published>
      <atom:author><atom:name>Atom Author</atom:name></atom:author>
      <atom:link rel="alternate" href="https://example.com/prefixed" />
      <atom:summary>&lt;p&gt;Namespaced summary.&lt;/p&gt;</atom:summary>
    </atom:entry>
  </atom:feed>`);
  assert.deepEqual(entries, [{
    guid: "prefixed",
    title: "Prefixed Atom",
    url: "https://example.com/prefixed",
    publishedAt: "2026-08-31T03:00:00.000Z",
    author: "Atom Author",
    summary: "Namespaced summary.",
    content: "Namespaced summary.",
    mediaUrls: [],
  }]);
});

test("rejects DOCTYPE, malformed, oversized, non-UTF-8, and excessive-entry input", () => {
  assert.throws(
    () => parseFeed(`<!DOCTYPE rss [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><rss version="2.0"><channel /></rss>`),
    /DOCTYPE/,
  );
  assert.throws(() => parseFeed("<rss><channel></rss>"), /Malformed feed XML/);
  assert.throws(() => parseFeed("<rss version=\"2.0\"><channel /></rss>", { maxBytes: 10 }), /byte limit/);
  assert.throws(() => parseFeed(Uint8Array.from([0xc3, 0x28])), /valid UTF-8/);
  assert.throws(
    () => parseFeed(`<rss version="2.0"><channel><item /><item /></channel></rss>`, { maxEntries: 1 }),
    /entry limit/,
  );
  assert.throws(() => parseFeed("<root />"), /RSS 2.0 channel or Atom feed/);
});

test("bounds sanitized text and rejects unsafe canonical and media URLs", () => {
  assert.equal(feedParserInternals.htmlToBoundedText("<p>123456789</p>", 6), "12345…");
  assert.equal(feedParserInternals.htmlToBoundedText("<style>bad</style><p>A&#x1F3E0;&nbsp;B</p>", 20), "A🏠 B");
  assert.equal(feedParserInternals.safeHttpsUrl("https://User:secret@example.com/private"), undefined);
  assert.equal(feedParserInternals.safeHttpsUrl("javascript:alert(1)"), undefined);

  const entries = parseFeed(`<rss version="2.0"><channel><item>
    <guid>bounded</guid><title>Long title here</title><link>https://example.com/item</link>
    <pubDate>2026-08-31T00:00:00Z</pubDate>
    <description><![CDATA[<p>Summary text that is long.</p><img src="https://user:password@example.com/no.png" /><img src="javascript:bad" />]]></description>
  </item></channel></rss>`, { maxTitleLength: 8, maxSummaryLength: 10, maxContentLength: 12 });
  assert.equal(entries[0].title, "Long ti…");
  assert.equal(entries[0].summary, "Summary t…");
  assert.equal(entries[0].content, "Summary tex…");
  assert.deepEqual(entries[0].mediaUrls, []);
});

test("skips entries without a safe URL, valid date, or title", () => {
  const entries = parseFeed(`<rss version="2.0"><channel>
    <item><guid>a</guid><title>HTTP</title><link>http://example.com/a</link><pubDate>2026-08-31T00:00:00Z</pubDate></item>
    <item><guid>b</guid><title>Bad date</title><link>https://example.com/b</link><pubDate>not a date</pubDate></item>
    <item><guid>c</guid><title><![CDATA[<script>empty</script>]]></title><link>https://example.com/c</link><pubDate>2026-08-31T00:00:00Z</pubDate></item>
  </channel></rss>`);
  assert.deepEqual(entries, []);
});

test("normalizes safe sitemap URLs and last modification timestamps", () => {
  const entries = parseSitemap(`<?xml version="1.0" encoding="UTF-8"?>
    <urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
      <url>
        <loc>https://WWW.NABUCASA.com/news/one/?utm_source=sitemap&amp;b=2&amp;a=1#details</loc>
        <lastmod>2026-03-31</lastmod>
      </url>
      <url>
        <loc>https://www.nabucasa.com/news/two/</loc>
        <lastmod>2026-08-31T12:30:00+02:00</lastmod>
      </url>
    </urlset>`);

  assert.deepEqual(entries, [
    {
      loc: "https://www.nabucasa.com/news/one/?a=1&b=2",
      lastmod: "2026-03-31T00:00:00.000Z",
    },
    {
      loc: "https://www.nabucasa.com/news/two/",
      lastmod: "2026-08-31T10:30:00.000Z",
    },
  ]);
});

test("accepts prefixed sitemap elements and skips unsafe or incomplete entries", () => {
  const entries = parseSitemap(`<sm:urlset xmlns:sm="http://www.sitemaps.org/schemas/sitemap/0.9">
    <sm:url><sm:loc>https://example.com/news/safe</sm:loc><sm:lastmod>2026-08-31</sm:lastmod></sm:url>
    <sm:url><sm:loc>http://example.com/news/http</sm:loc><sm:lastmod>2026-08-31</sm:lastmod></sm:url>
    <sm:url><sm:loc>https://user:secret@example.com/private</sm:loc><sm:lastmod>2026-08-31</sm:lastmod></sm:url>
    <sm:url><sm:loc>https://example.com/news/no-date</sm:loc></sm:url>
    <sm:url><sm:loc>https://example.com/news/bad-date</sm:loc><sm:lastmod>not-a-date</sm:lastmod></sm:url>
  </sm:urlset>`);

  assert.deepEqual(entries, [{
    loc: "https://example.com/news/safe",
    lastmod: "2026-08-31T00:00:00.000Z",
  }]);
});

test("rejects unsafe, malformed, oversized, non-UTF-8, and excessive sitemap input", () => {
  assert.throws(
    () => parseSitemap(`<!DOCTYPE urlset [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><urlset />`),
    /DOCTYPE/,
  );
  assert.throws(() => parseSitemap("<urlset><url></urlset>"), /Malformed sitemap XML/);
  assert.throws(() => parseSitemap("<urlset />", { maxBytes: 5 }), /byte limit/);
  assert.throws(() => parseSitemap(Uint8Array.from([0xc3, 0x28])), /valid UTF-8/);
  assert.throws(
    () => parseSitemap(`<urlset><url /><url /></urlset>`, { maxEntries: 1 }),
    /entry limit/,
  );
  assert.throws(() => parseSitemap("<sitemapindex />"), /URL set/);
});
