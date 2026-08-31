import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import {
  queryContent,
  readContentStore,
  upsertContentStore,
  type StoredContent,
  type StoredContentInput,
} from "../src/lib/content-store";

function content(overrides: Partial<StoredContentInput> = {}): StoredContentInput {
  return {
    id: "home-assistant-blog-2026-08-local-energy",
    kind: "official_post",
    source: "Home Assistant Blog",
    title: "Local energy moves forward",
    url: "https://www.home-assistant.io/blog/2026/08/20/local-energy/",
    publishedAt: "2026-08-20T10:30:00Z",
    updatedAt: "2026-08-20T11:00:00Z",
    author: "Open Home Foundation",
    body: "An official explanation of new local energy work.",
    mediaUrls: [
      "https://www.home-assistant.io/images/blog/local-energy.png",
      "https://www.home-assistant.io/images/blog/local-energy.png",
      "http://unsafe.example/image.png",
    ],
    ...overrides,
  };
}

async function temporaryStore(): Promise<string> {
  return mkdtemp(resolve(tmpdir(), "ohf-content-store-"));
}

test("writes month-sharded NDJSON and keeps only safe HTTPS media", async (context) => {
  const directory = await temporaryStore();
  context.after(() => rm(directory, { recursive: true, force: true }));

  assert.deepEqual(await upsertContentStore(directory, [content()], new Date("2026-08-21T00:00:00Z")), { written: 1, unchanged: 0 });
  const lines = (await readFile(resolve(directory, "2026-08.ndjson"), "utf8")).trim().split("\n");
  assert.equal(lines.length, 1);
  const [stored] = await readContentStore(directory);
  assert.equal(stored.schemaVersion, 1);
  assert.equal(stored.revision, 1);
  assert.deepEqual(stored.mediaUrls, ["https://www.home-assistant.io/images/blog/local-energy.png"]);
});

test("does not append unchanged content and appends auditable revisions", async (context) => {
  const directory = await temporaryStore();
  context.after(() => rm(directory, { recursive: true, force: true }));

  await upsertContentStore(directory, [content()], new Date("2026-08-21T00:00:00Z"));
  assert.deepEqual(await upsertContentStore(directory, [content()], new Date("2026-08-22T00:00:00Z")), { written: 0, unchanged: 1 });
  await upsertContentStore(directory, [content({ title: "Local energy moves further" })], new Date("2026-08-23T00:00:00Z"));

  const lines = (await readFile(resolve(directory, "2026-08.ndjson"), "utf8")).trim().split("\n");
  assert.equal(lines.length, 2);
  const [latest] = await readContentStore(directory);
  assert.equal(latest.revision, 2);
  assert.equal(latest.title, "Local energy moves further");
  assert.equal(latest.firstSeenAt, "2026-08-21T00:00:00.000Z");
});

test("merges repeated ids in one batch without discarding richer fields", async (context) => {
  const directory = await temporaryStore();
  context.after(() => rm(directory, { recursive: true, force: true }));

  await upsertContentStore(directory, [
    content({ body: null, author: null, mediaUrls: [] }),
    content({ body: "Detailed reporting.", mediaUrls: ["https://example.com/detail.png"] }),
  ]);
  const [stored] = await readContentStore(directory);
  assert.equal(stored.body, "Detailed reporting.");
  assert.equal(stored.author, "Open Home Foundation");
  assert.deepEqual(stored.mediaUrls, ["https://example.com/detail.png"]);
});

test("deduplicates records with the same canonical URL and prefers richer content", async (context) => {
  const directory = await temporaryStore();
  context.after(() => rm(directory, { recursive: true, force: true }));

  await upsertContentStore(directory, [
    content({ id: "feed-entry", body: null, author: null, mediaUrls: [], url: "https://example.com/story" }),
    content({ id: "page-entry", body: "Full article body.", url: "https://EXAMPLE.com/story/" }),
  ]);
  const records = await readContentStore(directory);
  assert.equal(records.length, 1);
  assert.equal(records[0].id, "page-entry");
  assert.equal(records[0].body, "Full article body.");
});

test("prefers an official post over alert coverage of the same canonical page", async (context) => {
  const directory = await temporaryStore();
  context.after(() => rm(directory, { recursive: true, force: true }));

  await upsertContentStore(directory, [
    content({ id: "alert", kind: "external_coverage", source: "Google Alert", body: "A longer alert excerpt.", url: "https://example.com/story" }),
    content({ id: "official", kind: "official_post", body: "Official post.", url: "https://example.com/story/" }),
  ]);
  const records = await readContentStore(directory);
  assert.equal(records.length, 1);
  assert.equal(records[0].id, "official");
  assert.equal(records[0].kind, "official_post");
});

test("queries kind, exact source, text, time bounds, and limit", () => {
  const first: StoredContent = {
    ...content(),
    schemaVersion: 1,
    revision: 1,
    firstSeenAt: "2026-08-21T00:00:00Z",
    storedAt: "2026-08-21T00:00:00Z",
    mediaUrls: ["https://www.home-assistant.io/images/blog/local-energy.png"],
  };
  const second: StoredContent = {
    ...first,
    id: "independent-analysis",
    kind: "external_coverage",
    source: "Example Technology News",
    title: "Independent analysis of local voice",
    body: "The report examines privacy and adoption.",
    author: "Reporter Name",
    url: "https://news.example/voice-analysis",
    publishedAt: "2026-08-25T09:00:00Z",
  };

  assert.deepEqual(queryContent([first, second], { kind: "official_post", source: "home assistant blog" }).map((item) => item.id), [first.id]);
  assert.deepEqual(queryContent([first, second], { kind: "external_coverage", text: "privacy" }).map((item) => item.id), [second.id]);
  assert.deepEqual(queryContent([first, second], { since: "2026-08-20", before: "2026-08-25" }).map((item) => item.id), [first.id]);
  assert.deepEqual(queryContent([first, second], { limit: 1 }).map((item) => item.id), [second.id]);
  assert.throws(() => queryContent([first], { before: "not-a-date" }), /before/);
  assert.throws(() => queryContent([first], { limit: 0 }), /positive integer/);
});

test("rejects unsafe source URLs and invalid timestamps", async (context) => {
  const directory = await temporaryStore();
  context.after(() => rm(directory, { recursive: true, force: true }));
  await assert.rejects(upsertContentStore(directory, [content({ url: "http://example.com/story" })]), /safe HTTPS URL/);
  await assert.rejects(upsertContentStore(directory, [content({ url: "https://user:secret@example.com/story" })]), /safe HTTPS URL/);
  await assert.rejects(upsertContentStore(directory, [content({ publishedAt: "not-a-date" })]), /publishedAt/);
});

test("reports corrupt NDJSON with a precise shard line", async (context) => {
  const directory = await temporaryStore();
  context.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(resolve(directory, "2026-08.ndjson"), "{not json}\n");
  await assert.rejects(readContentStore(directory), /2026-08\.ndjson:1/);
});
