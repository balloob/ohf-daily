import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { editorialInternals } from "../src/lib/editorial";
import type { StoredContent } from "../src/lib/content-store";
import type { StoredPullRequest } from "../src/lib/pr-store";
import type { ReleasePreview } from "../src/lib/types";

const record: StoredPullRequest = {
  schemaVersion: 1,
  revision: 1,
  firstSeenAt: "2026-08-24T10:00:00Z",
  storedAt: "2026-08-24T10:00:00Z",
  id: 42,
  number: 42,
  url: "https://github.com/home-assistant/core/pull/42",
  apiUrl: "https://api.github.com/repos/home-assistant/core/pulls/42",
  repository: "home-assistant/core",
  organization: "Home Assistant",
  title: "Add SolarEdge discovery",
  body: "Builds on the sensor platform.",
  author: "frenck",
  authorProfile: {
    login: "frenck",
    name: "Franck Nijhof",
    avatarUrl: "https://avatars.githubusercontent.com/u/195327?v=4",
    profileUrl: "https://github.com/frenck",
  },
  mergedAt: "2026-08-24T09:00:00Z",
  githubUpdatedAt: "2026-08-24T09:00:00Z",
  labels: ["integration: solaredge"],
  mediaUrls: ["https://github.com/user-attachments/assets/example.png"],
  reviewers: ["human-reviewer", "esphbot"],
  approvers: ["human-reviewer", "bluetoothbot"],
  stats: { additions: 100, changedFiles: 4 },
  isDependency: false,
};

const officialPost: StoredContent = {
  schemaVersion: 1,
  revision: 1,
  firstSeenAt: "2026-08-31T10:00:00Z",
  storedAt: "2026-08-31T10:00:00Z",
  id: "home-assistant-blog:official",
  kind: "official_post",
  source: "Home Assistant Blog",
  title: "A public announcement",
  url: "https://www.home-assistant.io/blog/2026/08/31/public-announcement/",
  publishedAt: "2026-08-31T08:00:00Z",
  author: "Home Assistant",
  body: "The official post explains the program.",
  mediaUrls: [],
};

const releasePreview: ReleasePreview = {
  id: "Home Assistant/2026.9",
  product: "Home Assistant",
  version: "2026.9",
  title: "Home Assistant 2026.9 preview",
  url: "https://rc.home-assistant.io/blog/2026/08/26/release-20269/",
  body: "A mutable preview of the September release.",
  mediaUrls: ["https://rc.home-assistant.io/images/blog/2026-09/dashboard.png"],
  contentHash: "a".repeat(64),
  fetchedAt: "2026-09-02T05:00:00Z",
  releaseDate: "2026-09-02",
};

test("identifies Monday editions and seven-day recap bounds", () => {
  assert.equal(editorialInternals.monday("2026-08-31"), true);
  assert.equal(editorialInternals.monday("2026-09-01"), false);
  assert.equal(editorialInternals.daysBefore("2026-08-31", 7), "2026-08-24T00:00:00.000Z");
  assert.deepEqual(editorialInternals.recapBounds("2026-08-31", "Europe/Amsterdam"), {
    start: "2026-08-23T22:00:00.000Z",
    end: "2026-08-30T22:00:00.000Z",
  });
  assert.deepEqual(editorialInternals.recapBounds("2026-03-30", "Europe/Amsterdam"), {
    start: "2026-03-22T23:00:00.000Z",
    end: "2026-03-29T22:00:00.000Z",
  });
});

test("derives active beta windows from configured release cycles", () => {
  assert.deepEqual(editorialInternals.activeBetaWindows("2026-08-31", [
    { product: "Home Assistant", kind: "Release", date: "2026-09-02", accent: "blue" },
    { product: "ESPHome", kind: "Beta", date: "2026-09-09", accent: "green" },
    { product: "ESPHome", kind: "Release", date: "2026-09-16", accent: "green" },
  ], [
    { product: "Home Assistant", rule: "first-wednesday", beta_days_before: 7, release_offset_days: 0, accent: "blue" },
    { product: "ESPHome", rule: "first-wednesday", beta_days_before: 7, release_offset_days: 14, accent: "green" },
  ]), [
    { product: "Home Assistant", betaStart: "2026-08-26", releaseDate: "2026-09-02" },
  ]);
});

test("loads recent published article context newest edition first", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "ohf-editorial-history-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const writeEdition = (date: string, title: string, topics: string[], placement: "lead" | "feature" | "brief") => writeFile(
    join(directory, `${date}.json`),
    JSON.stringify({ date, articles: [{ title, topics, kind: "daily", placement }] }),
  );
  await Promise.all([
    writeEdition("2026-08-28", "Oldest", ["architecture"], "feature"),
    writeEdition("2026-08-29", "Middle", ["performance"], "brief"),
    writeEdition("2026-08-30", "Newest", ["security", "privacy"], "lead"),
    writeEdition("2026-08-31", "Current edition", ["ignored"], "lead"),
  ]);

  assert.deepEqual(await editorialInternals.loadRecentPublishedArticles(directory, "2026-08-31", 2), [
    { date: "2026-08-30", title: "Newest", topics: ["security", "privacy"], kind: "daily", placement: "lead" },
    { date: "2026-08-29", title: "Middle", topics: ["performance"], kind: "daily", placement: "brief" },
  ]);
});

test("exposes cached contributor identity to the reporting agent", () => {
  const compact = editorialInternals.compactRecord(record) as { authorProfile?: unknown };
  assert.deepEqual(compact.authorProfile, record.authorProfile);
});

test("can provide the release reporter with the full bounded preview body", () => {
  const content = editorialInternals.releasePreviewContent({ ...releasePreview, body: "x".repeat(10_000) });
  const ordinary = editorialInternals.compactContentRecord(content) as { description: string };
  const release = editorialInternals.compactContentRecord(content, 12_000) as { description: string };
  assert.equal(ordinary.description.length, 4_000);
  assert.equal(release.description.length, 10_000);
});

test("resolves only locally evidenced PRs and media, including review credit", () => {
  const articles = editorialInternals.resolveArticles([
    {
      id: "solaredge-progress",
      title: "SolarEdge setup grows around its sensors",
      dek: "Discovery follows the earlier sensor work.",
      body: ["The related merged work now forms one product story."],
      kind: "daily",
      placement: "feature",
      score: 90,
      contributors: ["frenck"],
      topics: ["energy"],
      continuity: "This builds on earlier SolarEdge work.",
      pullRequestIds: ["42", "999"],
      contentSourceIds: [],
      media: [
        { type: "image", url: record.mediaUrls[0], alt: "Screenshot attached to the SolarEdge pull request", caption: null, poster: null },
        { type: "image", url: "https://example.com/invented.png", alt: "Invented", caption: null, poster: null },
      ],
    },
  ], [record]);
  assert.equal(articles.length, 1);
  assert.equal(articles[0].placement, "lead");
  assert.deepEqual(articles[0].pullRequests.map((source) => source.id), ["42"]);
  assert.deepEqual(articles[0].media.map((media) => media.url), [record.mediaUrls[0]]);
  assert.deepEqual(articles[0].reviewers, ["human-reviewer"]);
  assert.deepEqual(articles[0].approvers, ["human-reviewer"]);
  assert.deepEqual(articles[0].contributors, ["frenck"]);
  assert.deepEqual(articles[0].contributorProfiles, [record.authorProfile]);
});

test("derives contributor and human review credit from sources rather than model output", () => {
  const second: StoredPullRequest = {
    ...record,
    id: 43,
    number: 43,
    url: "https://github.com/home-assistant/core/pull/43",
    author: "new-author",
    authorProfile: undefined,
    reviewers: ["new-author", "Human-Reviewer", "renovate[bot]"],
    approvers: ["new-author", "Second-Approver"],
  };
  const articles = editorialInternals.resolveArticles([{
    id: "grouped-story",
    title: "A grouped story",
    dek: "Two contributions form one outcome.",
    body: ["The sources establish the result."],
    kind: "daily",
    placement: "feature",
    score: 80,
    contributors: ["invented-model-credit"],
    topics: ["testing"],
    continuity: null,
    pullRequestIds: ["42", "43"],
    contentSourceIds: [],
    media: [],
  }], [record, second]);

  assert.deepEqual(articles[0].contributors, ["frenck", "new-author"]);
  assert.deepEqual(articles[0].reviewers, ["human-reviewer"]);
  assert.deepEqual(articles[0].approvers, ["human-reviewer", "Second-Approver"]);
});

test("resolves official posts beside PR evidence and allows an official-only article", () => {
  const shared = {
    title: "An announcement with implementation context",
    dek: "Official context joins merged work.",
    body: ["The source ledger keeps both kinds of evidence."],
    kind: "daily" as const,
    placement: "feature" as const,
    score: 80,
    contributors: [],
    topics: ["community"],
    continuity: null,
    media: [],
  };
  const articles = editorialInternals.resolveArticles([{
    ...shared,
    id: "mixed-evidence",
    pullRequestIds: ["42"],
    contentSourceIds: [officialPost.id],
  }, {
    ...shared,
    id: "official-only",
    pullRequestIds: [],
    contentSourceIds: [officialPost.id],
  }], [record], [officialPost]);

  assert.equal(articles.length, 2);
  assert.deepEqual(articles[0].pullRequests.map((source) => source.id), ["42"]);
  assert.deepEqual(articles[0].externalSources?.map((source) => source.id), [officialPost.id]);
  assert.deepEqual(articles[0].contributors, ["frenck"]);
  assert.equal(articles[1].pullRequests.length, 0);
  assert.deepEqual(articles[1].externalSources?.map((source) => source.kind), ["official_post"]);
});

test("rejects an article supported only by Google Alert coverage", () => {
  const alert: StoredContent = { ...officialPost, id: "google-alert:lead", kind: "external_coverage", source: "Google Alert" };
  const articles = editorialInternals.resolveArticles([{
    id: "alert-only",
    title: "An uncorroborated mention",
    dek: "This must not publish.",
    body: ["Alert snippets are leads, not evidence."],
    kind: "daily",
    placement: "feature",
    score: 70,
    contributors: [],
    topics: ["coverage"],
    continuity: null,
    pullRequestIds: [],
    contentSourceIds: [alert.id],
    media: [],
  }], [], [alert]);
  assert.deepEqual(articles, []);
});

test("forces a release-day source into the lead and accepts its official media", () => {
  const previewContent = editorialInternals.releasePreviewContent(releasePreview);
  const base = {
    dek: "Official release notes provide the evidence.",
    body: ["The release is due today."],
    kind: "daily" as const,
    score: 80,
    contributors: [],
    topics: ["release"],
    continuity: null,
    pullRequestIds: [],
  };
  const articles = editorialInternals.resolveArticles([{
    ...base,
    id: "ordinary-lead",
    title: "Another story",
    placement: "lead",
    contentSourceIds: [officialPost.id],
    media: [],
  }, {
    ...base,
    id: "release-story",
    title: "Home Assistant 2026.9 is due today",
    placement: "feature",
    contentSourceIds: [previewContent.id],
    media: [{ type: "image", url: releasePreview.mediaUrls[0], alt: "Release dashboard", caption: null, poster: null }],
  }], [], [officialPost, previewContent], [previewContent.id]);

  assert.equal(articles[0].id, "release-story");
  assert.equal(articles[0].placement, "lead");
  assert.equal(articles[1].placement, "feature");
  assert.deepEqual(articles[0].media.map((media) => media.url), releasePreview.mediaUrls);
});

test("rejects a release-day plan that omits its mandatory official source", () => {
  const previewContent = editorialInternals.releasePreviewContent(releasePreview);
  assert.throws(() => editorialInternals.resolveArticles([{
    id: "wrong-story",
    title: "An unrelated story",
    dek: "This cannot displace the release.",
    body: ["Unrelated."],
    kind: "daily",
    placement: "lead",
    score: 99,
    contributors: [],
    topics: [],
    continuity: null,
    pullRequestIds: [],
    contentSourceIds: [officialPost.id],
    media: [],
  }], [], [officialPost, previewContent], [previewContent.id]), /omitted mandatory official source/);
});

test("marks a release preview shipped only when a matching stable release landed", () => {
  assert.equal(editorialInternals.releasePreviewStatus(releasePreview, []), "due_today");
  assert.equal(editorialInternals.releasePreviewStatus(releasePreview, [{
    id: "ha:2026.9.0",
    product: "Home Assistant",
    repository: "home-assistant/core",
    name: "Home Assistant 2026.9.0",
    tag: "2026.9.0",
    url: "https://github.com/home-assistant/core/releases/tag/2026.9.0",
    publishedAt: "2026-09-02T06:30:00Z",
    channel: "stable",
    accent: "blue",
  }]), "released");
  assert.equal(editorialInternals.releasePreviewStatus(releasePreview, [{
    id: "ha:beta",
    product: "Home Assistant",
    repository: "home-assistant/core",
    name: "Home Assistant 2026.9 beta",
    tag: "2026.9.0b1",
    url: "https://github.com/home-assistant/core/releases/tag/2026.9.0b1",
    publishedAt: "2026-08-26T06:30:00Z",
    channel: "prerelease",
    accent: "blue",
  }]), "due_today");
});

test("parses exact local-history tool filters", () => {
  assert.deepEqual(editorialInternals.historyQueryFromArguments(JSON.stringify({
    repository: "home-assistant/core",
    author: "frenck",
    label: "integration: solaredge",
    text: null,
    since: "2026-08-01",
    before: "2026-08-31",
    limit: 12,
  })), {
    repository: "home-assistant/core",
    author: "frenck",
    label: "integration: solaredge",
    text: undefined,
    since: "2026-08-01",
    before: "2026-08-31",
    limit: 12,
  });
});

test("parses exact local content-history filters", () => {
  assert.deepEqual(editorialInternals.contentQueryFromArguments(JSON.stringify({
    kind: "official_post",
    source: "Home Assistant Blog",
    text: "local voice",
    since: "2026-08-01",
    before: null,
    limit: 100,
  })), {
    kind: "official_post",
    source: "Home Assistant Blog",
    text: "local voice",
    since: "2026-08-01",
    before: undefined,
    limit: 30,
  });
});
