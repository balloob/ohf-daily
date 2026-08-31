import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { parseQueryArguments, runPullRequestQuery } from "../scripts/query-prs";
import {
  queryPullRequests,
  readPullRequestStore,
  upsertPullRequestStore,
  type StoredPullRequestInput,
} from "../src/lib/pr-store";

function pullRequest(overrides: Partial<StoredPullRequestInput> = {}): StoredPullRequestInput {
  return {
    id: 101,
    number: 42,
    url: "https://github.com/home-assistant/core/pull/42",
    apiUrl: "https://api.github.com/repos/home-assistant/core/pulls/42",
    repository: "home-assistant/core",
    organization: "Home Assistant",
    title: "Add SolarEdge diagnostics",
    body: "Adds richer local energy diagnostics and a migration note.",
    author: "ExampleAuthor",
    authorProfile: {
      login: "ExampleAuthor",
      name: "Example Author",
      avatarUrl: "https://avatars.githubusercontent.com/u/123?v=4",
      profileUrl: "https://github.com/ExampleAuthor",
    },
    mergedAt: "2026-08-20T10:30:00Z",
    githubUpdatedAt: "2026-08-20T10:31:00Z",
    labels: ["Integration: SolarEdge", "Feature", "feature"],
    mediaUrls: ["https://github.com/user-attachments/assets/preview", "http://unsafe.example/image.png"],
    reviewers: ["HelpfulHuman"],
    approvers: ["HelpfulHuman"],
    firstContribution: { mergedAt: "2024-01-02T03:04:05Z", url: "https://github.com/home-assistant/core/pull/17", number: 17 },
    isFirstContribution: false,
    stats: { additions: 50, deletions: 4, changedFiles: 3, comments: 2, reviewComments: 1 },
    isDependency: false,
    ...overrides,
  };
}

async function temporaryStore(): Promise<string> {
  return mkdtemp(resolve(tmpdir(), "ohf-pr-store-"));
}

test("writes month-sharded NDJSON and normalizes labels and media", async (context) => {
  const directory = await temporaryStore();
  context.after(() => rm(directory, { recursive: true, force: true }));
  const result = await upsertPullRequestStore(directory, [pullRequest()], new Date("2026-08-21T00:00:00Z"));
  assert.deepEqual(result, { written: 1, unchanged: 0 });
  const lines = (await readFile(resolve(directory, "2026-08.ndjson"), "utf8")).trim().split("\n");
  assert.equal(lines.length, 1);
  const [stored] = await readPullRequestStore(directory);
  assert.deepEqual(stored.labels, ["feature", "integration: solaredge"]);
  assert.deepEqual(stored.mediaUrls, ["https://github.com/user-attachments/assets/preview"]);
  assert.equal(stored.firstContribution?.number, 17);
  assert.equal(stored.authorProfile?.name, "Example Author");
  assert.equal(stored.authorProfile?.avatarUrl, "https://avatars.githubusercontent.com/u/123?v=4");
  assert.equal(stored.isFirstContribution, false);
  assert.equal(stored.revision, 1);
});

test("does not append unchanged PRs and appends auditable revisions for updates", async (context) => {
  const directory = await temporaryStore();
  context.after(() => rm(directory, { recursive: true, force: true }));
  await upsertPullRequestStore(directory, [pullRequest()], new Date("2026-08-21T00:00:00Z"));
  assert.deepEqual(await upsertPullRequestStore(directory, [pullRequest()], new Date("2026-08-22T00:00:00Z")), { written: 0, unchanged: 1 });
  await upsertPullRequestStore(directory, [pullRequest({ title: "Add richer SolarEdge diagnostics", stats: { additions: 55 } })], new Date("2026-08-23T00:00:00Z"));

  const lines = (await readFile(resolve(directory, "2026-08.ndjson"), "utf8")).trim().split("\n");
  assert.equal(lines.length, 2);
  const [latest] = await readPullRequestStore(directory);
  assert.equal(latest.revision, 2);
  assert.equal(latest.title, "Add richer SolarEdge diagnostics");
  assert.equal(latest.stats.additions, 55);
  assert.equal(latest.stats.changedFiles, 3);
  assert.equal(latest.firstSeenAt, "2026-08-21T00:00:00.000Z");
});

test("deduplicates repeated ids in one batch and shards by merge month", async (context) => {
  const directory = await temporaryStore();
  context.after(() => rm(directory, { recursive: true, force: true }));
  await upsertPullRequestStore(
    directory,
    [pullRequest({ body: null, stats: { comments: 2 } }), pullRequest({ body: "Detailed body", stats: { additions: 50 } })],
    new Date("2026-09-01T00:00:00Z"),
  );
  const records = await readPullRequestStore(directory);
  assert.equal(records.length, 1);
  assert.equal(records[0].body, "Detailed body");
  assert.equal(records[0].stats.comments, 2);
  assert.equal(records[0].stats.additions, 50);
});

test("collapses legacy search and detail records for the same repository pull request", async (context) => {
  const directory = await temporaryStore();
  context.after(() => rm(directory, { recursive: true, force: true }));
  await upsertPullRequestStore(
    directory,
    [
      pullRequest({
        id: 201,
        repository: "home-assistant/core",
        body: null,
        apiUrl: undefined,
        reviewers: [],
        approvers: [],
        stats: { comments: 2 },
      }),
      pullRequest({
        id: 202,
        repository: "HOME-ASSISTANT/Core",
        body: "The fully enriched pull request body.",
        reviewers: ["HelpfulHuman"],
        approvers: ["HelpfulHuman"],
        stats: { additions: 50, deletions: 4, changedFiles: 3, comments: 2, reviewComments: 1 },
      }),
    ],
    new Date("2026-08-21T00:00:00Z"),
  );

  const records = await readPullRequestStore(directory);
  assert.equal(records.length, 1);
  assert.equal(records[0].id, 202);
  assert.equal(records[0].body, "The fully enriched pull request body.");
  assert.deepEqual(records[0].approvers, ["HelpfulHuman"]);
});

test("queries exact repo, author, normalized label, text, and time bounds", () => {
  const first = {
    ...pullRequest(),
    schemaVersion: 1 as const,
    revision: 1,
    firstSeenAt: "2026-08-21T00:00:00Z",
    storedAt: "2026-08-21T00:00:00Z",
    labels: ["feature", "integration: solaredge"],
  };
  const second = {
    ...first,
    id: 102,
    repository: "esphome/esphome",
    author: "Builder",
    title: "Fix Bluetooth proxy",
    body: "Prevents a reconnect crash.",
    mergedAt: "2026-08-25T09:00:00Z",
    labels: ["bug"],
  };
  assert.deepEqual(queryPullRequests([first, second], { repository: "home-assistant/core", label: "Integration: SolarEdge" }).map((item) => item.id), [101]);
  assert.deepEqual(queryPullRequests([first, second], { author: "builder", text: "reconnect" }).map((item) => item.id), [102]);
  assert.deepEqual(queryPullRequests([first, second], { since: "2026-08-20", before: "2026-08-25" }).map((item) => item.id), [101]);
  assert.deepEqual(queryPullRequests([first, second], { limit: 1 }).map((item) => item.id), [102]);
  assert.throws(() => queryPullRequests([first], { before: "not-a-date" }), /--before/);
});

test("parses query CLI options and returns JSON-ready offline results", async (context) => {
  assert.deepEqual(parseQueryArguments(["--repo", "home-assistant/core", "--label", "integration: solaredge", "--before", "2026-09-01", "--limit", "5"]), {
    repository: "home-assistant/core",
    label: "integration: solaredge",
    before: "2026-09-01",
    limit: 5,
  });
  assert.throws(() => parseQueryArguments(["--unknown", "value"]), /Unknown option/);
  assert.throws(() => parseQueryArguments(["--limit", "0"]), /positive integer/);

  const directory = await temporaryStore();
  context.after(() => rm(directory, { recursive: true, force: true }));
  await upsertPullRequestStore(directory, [pullRequest()]);
  const results = await runPullRequestQuery(["--label", "integration: solaredge"], directory);
  assert.equal(results.length, 1);
  assert.equal(results[0].id, 101);
  assert.equal(results[0].authorProfile?.name, "Example Author");
  assert.equal(results[0].authorProfile?.avatarUrl, "https://avatars.githubusercontent.com/u/123?v=4");
});

test("reports corrupt NDJSON with a precise shard line", async (context) => {
  const directory = await temporaryStore();
  context.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(resolve(directory, "2026-08.ndjson"), "{not json}\n");
  await assert.rejects(readPullRequestStore(directory), /2026-08\.ndjson:1/);
});
