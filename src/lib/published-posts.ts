import type { StoredContentInput } from "./content-store";
import type { PublishedPost } from "./types";

/** Publication dates, not collection or update times, determine today's links. */
export function publishedPostsForWindow(records: StoredContentInput[], start: string, end: string): PublishedPost[] {
  const from = Date.parse(start);
  const through = Date.parse(end);
  const posts = new Map<string, PublishedPost>();
  for (const record of records) {
    const published = Date.parse(record.publishedAt);
    if (record.kind !== "official_post" || !Number.isFinite(published) || !(published >= from && published <= through)) continue;
    let url: URL;
    try { url = new URL(record.url); } catch { continue; }
    if (url.protocol !== "https:" || url.username || url.password) continue;
    url.hash = "";
    const key = url.href.replace(/\/$/, "");
    if (posts.has(key)) continue;
    posts.set(key, {
      id: record.id, title: record.title, url: url.href, publisher: record.source,
      publishedAt: record.publishedAt,
      kind: /newsletter/i.test(record.source) ? "Newsletter" : "Blog post",
    });
  }
  return [...posts.values()].sort((a, b) => b.publishedAt.localeCompare(a.publishedAt) || a.id.localeCompare(b.id));
}
