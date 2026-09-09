import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { editorialInternals, runEditorial } from "../src/lib/editorial";
import { recordRoadmapObservation, type RoadmapSnapshot } from "../src/lib/roadmap-store";
import type { Edition } from "../src/lib/types";

const roadmap: RoadmapSnapshot = {
  schemaVersion: 1, id: "roadmap:item", itemId: "item", projectId: "project", projectUrl: "https://github.com/orgs/OpenHomeFoundation/projects/8",
  type: "Issue", title: "Explore clearer device connections", body: "Consider grouping shared connections. ![Mockup](https://github.com/user-attachments/assets/mockup)",
  author: { login: "proposer", name: "Example Proposer" },
  url: "https://github.com/OpenHomeFoundation/roadmap/issues/235", repository: "OpenHomeFoundation/roadmap", number: 235,
  status: "Considering", mainProject: "Home Assistant", area: "Devices", priority: null, deliveryStatus: null,
  contentCreatedAt: "2026-08-01T10:00:00Z", contentUpdatedAt: "2026-09-09T03:00:00Z", itemCreatedAt: "2026-08-01T10:00:00Z", itemUpdatedAt: "2026-09-09T03:00:00Z",
  comments: [{ id: "comment", url: "https://github.com/OpenHomeFoundation/roadmap/issues/235#issuecomment-1", author: "maintainer", body: "I rewrote the opportunity to clarify the problem.", createdAt: "2026-09-09T04:02:00.000Z", updatedAt: "2026-09-09T04:02:00.000Z" }], commentCount: 1, observedAt: "2026-09-09T04:03:00.000Z", firstSeenAt: "2026-09-09T04:03:00.000Z",
  revision: 1, previousRevision: null, lastChangedAt: null, changeKind: "baseline", changedFields: [], present: true,
};

const proposal = {
  id: "device-connections", title: "Home Assistant explores clearer device connections", dek: "An opportunity under consideration.",
  body: ["The roadmap considers a clearer account of shared connections."], kind: "daily" as const, placement: "feature" as const,
  score: 75, contributors: [], topics: ["roadmap"], continuity: null, pullRequestIds: [], contentSourceIds: [],
  roadmapSourceIds: [roadmap.id], media: [],
};

const edition: Edition = {
  date: "2026-09-09", generatedAt: "2026-09-09T04:05:00.000Z", windowStart: "2026-09-08T04:00:00.000Z", windowEnd: "2026-09-09T04:00:00.000Z",
  timezone: "Europe/Amsterdam", stats: { mergedPullRequests: 0, repositories: 0, contributors: 0, dependencyUpdates: 0 },
  lead: null, highlights: [], briefs: [], dependencies: [], releases: [],
};

test("roadmap-only articles resolve to public issue sources with observed status and exact media", () => {
  const [article] = editorialInternals.resolveArticles([{ ...proposal, media: [
    { type: "image", url: "https://github.com/user-attachments/assets/mockup", alt: "An exploratory mockup", caption: null, poster: null },
    { type: "image", url: "https://example.com/invented.png", alt: "Not evidenced", caption: null, poster: null },
  ] }], [], [], [], [roadmap]);
  assert.equal(article.externalSources?.[0].kind, "roadmap");
  assert.equal(article.externalSources?.[0].url, roadmap.url);
  assert.equal(article.externalSources?.[0].status, "Considering");
  assert.equal(article.externalSources?.[0].publishedAt, roadmap.contentCreatedAt);
  assert.equal(article.externalSources?.[0].observedAt, roadmap.observedAt);
  assert.equal(article.media.length, 1);
  assert.deepEqual(article.pullRequests, []);
  assert.deepEqual(article.contributors, []);
});

test("resolver rejects unknown, draft-stage and draft-card roadmap references", () => {
  for (const sources of [[], [{ ...roadmap, status: "Draft" }], [{ ...roadmap, type: "DraftIssue" as const }]]) {
    assert.throws(() => editorialInternals.resolveArticles([proposal], [], [], [], sources), /Roadmap source/);
  }
});

test("roadmap sidebar summaries resolve exact sources without requiring a full article", () => {
  const [update] = editorialInternals.resolveRoadmapUpdates([{
    id: "connection-plan", title: "Clearer connections", summary: "A proposal explores a clearer connection view.", roadmapSourceIds: [roadmap.id],
  }], [roadmap]);
  assert.equal(update.sources[0].url, roadmap.url);
  assert.equal(update.sources[0].status, "Considering");
  assert.equal(update.sources[0].kind, "roadmap");
  assert.equal(update.articleId, undefined);
});

test("sidebar article links require an existing related article and public evidence", () => {
  const articles = editorialInternals.resolveArticles([proposal], [], [], [], [roadmap]);
  const update = { id: "connection-plan", title: "Clearer connections", summary: "An exploratory proposal.", roadmapSourceIds: [roadmap.id], articleId: proposal.id };
  assert.equal(editorialInternals.resolveRoadmapUpdates([update], [roadmap], articles)[0].articleId, proposal.id);
  assert.throws(() => editorialInternals.resolveRoadmapUpdates([{ ...update, articleId: "invented" }], [roadmap], articles), /missing or unrelated/);
  assert.throws(() => editorialInternals.resolveRoadmapUpdates([{ ...update, roadmapSourceIds: ["missing"] }], [roadmap], articles), /Roadmap source/);
  assert.throws(() => editorialInternals.resolveRoadmapUpdates([update], [{ ...roadmap, status: "Draft" }], articles), /Roadmap source/);
  assert.throws(() => editorialInternals.resolveRoadmapUpdates([{ ...update, roadmapSourceIds: [] }], [roadmap], articles), /needs public roadmap evidence/);
});

test("articles can retain their URLs without competing for the front-page lead", () => {
  const articles = editorialInternals.resolveArticles([
    { ...proposal, id: "old-published-url", placement: "lead", frontPage: false },
    { ...proposal, id: "selected-full-story", placement: "feature" },
  ], [], [], [], [roadmap]);
  assert.equal(articles.length, 2);
  assert.equal(articles.find((article) => article.id === "old-published-url")?.frontPage, false);
  assert.equal(articles.find((article) => article.id === "selected-full-story")?.placement, "lead");
  assert.equal(articles.filter((article) => article.frontPage !== false && article.placement === "lead").length, 1);
});

test("resolver has no 100-item cutoff and keeps the newest roadmap status", () => {
  const records = Array.from({ length: 150 }, (_, i) => ({ ...roadmap, id: `roadmap:${i}` }));
  records.push(roadmap, { ...roadmap, revision: 2, status: "Shaping" });
  const [article] = editorialInternals.resolveArticles([proposal], [], [], [], records);
  assert.equal(article.externalSources?.[0].status, "Shaping");
});

test("roadmap context separates bootstrap from changes and includes collection after the PR window", () => {
  const changed = { ...roadmap, revision: 2, previousRevision: 1, changeKind: "updated" as const, status: "Shaping", changedFields: ["status"], observedAt: "2026-09-09T04:04:00.000Z", lastChangedAt: "2026-09-09T04:04:00.000Z" };
  const initial = editorialInternals.roadmapEditorialContext([roadmap], edition, new Date("2026-09-09T06:00:00Z"));
  assert.equal(initial.baselineOnly, true);
  assert.equal(initial.context.length, 1);
  assert.equal(initial.changes.length, 0);
  const current = editorialInternals.roadmapEditorialContext([roadmap, changed], edition, new Date("2026-09-09T06:00:00Z"));
  assert.equal(current.changes[0].status, "Shaping");
  assert.equal(current.context[0].revision, 2);
  assert.equal(edition.windowEnd, "2026-09-09T04:00:00.000Z");
  const tomorrow = { ...changed, revision: 3, status: "Done", observedAt: "2026-09-10T04:00:00.000Z", lastChangedAt: "2026-09-10T04:00:00.000Z" };
  const historical = editorialInternals.roadmapEditorialContext([roadmap, changed, tomorrow], edition, new Date("2026-09-10T06:00:00Z"));
  assert.equal(historical.context[0].status, "Shaping");
  assert.equal(historical.cutoff, edition.generatedAt);
});

test("API newsroom supplies roadmap context and local history and publishes a roadmap-only plan", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ohf-roadmap-editorial-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "data/editions"), { recursive: true });
  await cp(resolve("prompts"), join(root, "prompts"), { recursive: true });
  await writeFile(join(root, "data/sources.yaml"), JSON.stringify({ ai: { model: "test", reasoning_effort: "low", max_parallel_reporters: 1, max_history_queries_per_reporter: 3 }, organizations: [], release_cycles: [], editorial_tracks: [{ slug: "roadmap", name: "Roadmap", prompt: "prompts/tracks/roadmap.md" }] }));
  await recordRoadmapObservation(join(root, "data/roadmap"), roadmap.projectId, [roadmap], new Date(roadmap.observedAt));
  const editionPath = join(root, "data/editions/2026-09-09.json");
  await writeFile(editionPath, JSON.stringify(edition));
  let calls = 0;
  const fetcher: typeof fetch = async (_url, init) => {
    const request = JSON.parse(String(init?.body));
    calls++;
    if (calls === 1) {
      const input = JSON.parse(request.input);
      assert.equal(input.roadmapBaselineOnly, true);
      assert.equal(input.roadmapChanges.length, 0);
      assert.equal(input.roadmapContext[0].id, roadmap.id);
      assert.deepEqual(input.roadmapContext[0].author, roadmap.author);
      assert.equal(input.roadmapContext[0].body, undefined);
      assert.equal(input.roadmapContext[0].latestComment.id, "comment");
      assert.equal(input.roadmapRecentDiscussion[0].comments[0].body, roadmap.comments[0].body);
      assert(request.tools.some((tool: { name: string }) => tool.name === "query_roadmap_history"));
      return Response.json({ id: "report-one", output: [{ type: "function_call", name: "query_roadmap_history", call_id: "history", arguments: JSON.stringify({ repository: roadmap.repository, number: roadmap.number, history: true, limit: 10 }) }] });
    }
    if (calls === 2) {
      assert.equal(JSON.parse(request.input[0].output).results[0].body, roadmap.body);
      return Response.json({ id: "report-two", output_text: JSON.stringify({ proposals: [proposal] }) });
    }
    assert.equal(request.metadata.stage, "editor");
    return Response.json({ id: "editor", output_text: JSON.stringify({ articles: [proposal], events: [], roadmapUpdates: [{ id: "connection-plan", title: "Clearer connections", summary: "An exploratory proposal.", roadmapSourceIds: [roadmap.id], articleId: proposal.id }] }) });
  };
  const articles = await runEditorial({ root, editionPath, apiKey: "test-not-a-secret", fetcher });
  assert.equal(calls, 3);
  assert.equal(articles[0].externalSources?.[0].kind, "roadmap");
  const updated = JSON.parse(await readFile(editionPath, "utf8"));
  assert.equal(updated.date, edition.date);
  assert.equal(updated.windowEnd, edition.windowEnd);
  assert.equal(updated.roadmapUpdates[0].articleId, proposal.id);
  assert.equal(updated.roadmapUpdates[0].sources[0].url, roadmap.url);
});
