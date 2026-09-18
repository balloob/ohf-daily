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
