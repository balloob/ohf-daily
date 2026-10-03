import assert from "node:assert/strict";
import test from "node:test";
import { publishedPostsForWindow } from "../src/lib/published-posts";
import type { StoredContentInput } from "../src/lib/content-store";

test("publication radar includes fresh official posts, not old updates, outside coverage or duplicate links", () => {
  const post: StoredContentInput = {
    id: "newsletter", kind: "official_post", source: "OHF Newsletter", title: "September news",
    url: "https://example.org/september/", publishedAt: "2026-09-17T12:00:00Z", body: null, mediaUrls: [],
  };
  const result = publishedPostsForWindow([
    post,
    { ...post, id: "duplicate", url: "https://example.org/september/#funding" },
    { ...post, id: "old", url: "https://example.org/old", publishedAt: "2026-09-10T12:00:00Z", updatedAt: "2026-09-17T13:00:00Z" },
    { ...post, id: "external", kind: "external_coverage", url: "https://example.org/coverage" },
    { ...post, id: "future", url: "https://example.org/future", publishedAt: "2026-09-19T00:00:00Z" },
    { ...post, id: "unsafe", url: "javascript:alert(1)" },
    { ...post, id: "blog", source: "Home Assistant Blog", url: "https://example.org/blog", publishedAt: "2026-09-17T13:00:00Z" },
  ], "2026-09-17T04:00:00Z", "2026-09-18T04:00:00Z");
  assert.deepEqual(result.map(({ id, kind }) => ({ id, kind })), [
    { id: "blog", kind: "Blog post" }, { id: "newsletter", kind: "Newsletter" },
  ]);
  assert.equal(result[1].title, post.title);
  assert.equal(result[1].publisher, post.source);
  assert.equal(result[1].url, post.url);
});

test("shared posts use the original publication once regardless of feed order", () => {
  const original: StoredContentInput = {
    id: "original", kind: "official_post", source: "Home Assistant Blog", title: "Cloud becomes Link",
    url: "https://www.home-assistant.io/blog/link/", publishedAt: "2026-10-02T12:00:00Z", body: null, mediaUrls: [],
  };
  const shared = { ...original, id: "shared", source: "Open Home Foundation Blog",
    url: "https://www.openhomefoundation.org/blog/link/", canonicalUrl: original.url };
  const separate = { ...original, id: "separate", source: "Nabu Casa News", url: "https://www.nabucasa.com/news/link/" };
  for (const records of [[shared, original, separate], [original, separate, shared]]) {
    const posts = publishedPostsForWindow(records, "2026-10-02T00:00:00Z", "2026-10-03T00:00:00Z");
    assert.deepEqual(posts.map(p => p.id), ["original", "separate"]);
    assert.equal(posts[0].url, original.url);
    assert.equal(posts[0].publisher, original.source);
  }
  const [onlyShared] = publishedPostsForWindow([shared], "2026-10-02T00:00:00Z", "2026-10-03T00:00:00Z");
  assert.equal(onlyShared.url, original.url);
});
