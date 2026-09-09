import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { collectRoadmap, fetchRoadmapItems, type RoadmapGraphQL } from "../src/lib/roadmap-collector";
import { queryRoadmap, readRoadmapStore, recordRoadmapObservation, type RoadmapItem } from "../src/lib/roadmap-store";
import { parseRoadmapQueryArguments, runRoadmapQuery } from "../scripts/query-roadmap";

const source = { enabled: true, project_id: "PVT_project", url: "https://github.com/orgs/OpenHomeFoundation/projects/8" };
const first = new Date("2026-09-09T10:00:00Z");
const second = new Date("2026-09-10T10:00:00Z");
function item(id = "item1"): RoadmapItem {
  return { id: `roadmap:${id}`, itemId: id, projectId: source.project_id, projectUrl: source.url, type: "Issue",
    title: "A public roadmap plan", body: "A public description", url: "https://github.com/home-assistant/architecture/issues/235", repository: "home-assistant/architecture", number: 235,
    status: "In progress", mainProject: "Home Assistant", area: "Automations", priority: "High", deliveryStatus: "On track",
    itemCreatedAt: first.toISOString(), itemUpdatedAt: first.toISOString(), contentCreatedAt: "2026-01-01T00:00:00Z", contentUpdatedAt: first.toISOString(), comments: [], commentCount: 0 };
}
function boardItem(id: string, kind = "Issue", isPrivate = false) {
  return { id, createdAt: first.toISOString(), updatedAt: first.toISOString(), fieldValues: { pageInfo: { hasNextPage: false }, nodes: [{ name: "In progress", field: { name: "Status" } }, { text: "Home Assistant", field: { name: "Main Project" } }, { name: "On track", field: { name: "Delivery Status" } }] },
    content: kind === "Issue" ? { __typename: kind, id: `issue-${id}`, repository: { isPrivate } } : kind === "DraftIssue" ? { __typename: kind, title: "Draft planning note", body: "Draft body", createdAt: first.toISOString(), updatedAt: first.toISOString() } : null };
}
function detail(id: string) {
  return { id, title: "Public issue", body: "Public body", url: "https://github.com/home-assistant/architecture/issues/235", author: { login: "planner", name: "Public Planner" }, number: 235, createdAt: first.toISOString(), updatedAt: first.toISOString(), repository: { isPrivate: false, nameWithOwner: "home-assistant/architecture" }, comments: { totalCount: 30, nodes: [{ id: "comment1", body: "Public follow-up", author: { login: "author", name: "Public Commenter" }, url: "https://github.com/home-assistant/architecture/issues/235#issuecomment-1", createdAt: first.toISOString(), updatedAt: first.toISOString() }] } };
}

test("roadmap paginates complete board and fetches only public issue details", async () => {
  const calls: Array<Record<string, unknown>> = [];
  const graphql: RoadmapGraphQL = async <T>(_query: string, variables: Record<string, unknown>): Promise<T> => {
    calls.push(variables);
    if (variables.ids) {
      assert.deepEqual(variables.ids, ["issue-public1", "issue-public2"]);
      return { nodes: (variables.ids as string[]).map((id, index) => {
        const issue = detail(id);
        return index === 0 ? issue : { ...issue, author: null, comments: { ...issue.comments, nodes: issue.comments.nodes.map((comment) => ({ ...comment, author: { login: "helper[bot]" } })) } };
      }) } as T;
    }
    return { node: { id: source.project_id, public: true, url: source.url, items: variables.after ? { nodes: [boardItem("public2"), boardItem("draft", "DraftIssue")], pageInfo: { hasNextPage: false, endCursor: "end" } } : { nodes: [boardItem("public1"), boardItem("private", "Issue", true), boardItem("redacted", "REDACTED")], pageInfo: { hasNextPage: true, endCursor: "next" } } } } as T;
  };
  const records = await fetchRoadmapItems(source, graphql);
  assert.equal(calls.length, 3);
  assert.equal(records.length, 3);
  assert.equal(records[0].status, "In progress");
  assert.equal(records[0].mainProject, "Home Assistant");
  assert.equal(records[0].deliveryStatus, "On track");
  assert.equal(records[0].commentCount, 30);
  assert.equal(records[0].comments[0].author, "author");
  assert.equal(records[0].comments[0].authorName, "Public Commenter");
  assert.deepEqual(records[0].author, { login: "planner", name: "Public Planner" });
  assert.equal(records[1].author, undefined);
  assert.equal(records[1].comments[0].author, "helper[bot]");
  assert.equal(records[1].comments[0].authorName, null);
  assert.equal(records[2].type, "DraftIssue");
  assert.ok(!JSON.stringify(records).includes("private"));
});

test("roadmap author enrichment stays backward compatible and does not create news deltas", async (t) => {
  const directory = await mkdtemp(resolve(tmpdir(), "roadmap-authors-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const previous: RoadmapItem = { ...item(), commentCount: 1, comments: [{ id: "comment1", url: `${item().url}#issuecomment-1`, author: "commenter", body: "Public comment", createdAt: first.toISOString(), updatedAt: first.toISOString() }] };
  await recordRoadmapObservation(directory, source.project_id, [previous], first);
  assert.equal((await readRoadmapStore(directory))[0].author, undefined);
  const enriched: RoadmapItem = { ...previous, author: { login: "planner", name: "Public Planner" }, comments: previous.comments.map((comment) => ({ ...comment, authorName: "Public Commenter" })) };
  assert.deepEqual(await recordRoadmapObservation(directory, source.project_id, [enriched], second), { baseline: false, written: 1, changed: 0 });
  const latest = (await readRoadmapStore(directory))[0];
  assert.deepEqual(latest.author, enriched.author);
  assert.equal(latest.comments[0].authorName, "Public Commenter");
  assert.deepEqual(latest.changedFields, []);
  assert.equal(latest.lastChangedAt, null);
  assert.equal(queryRoadmap([latest], { changedSince: first.toISOString() }).length, 0);
  const renamed = { ...enriched, author: { ...enriched.author!, name: "Updated Public Name" }, comments: enriched.comments.map((comment) => ({ ...comment, authorName: "Updated Commenter Name" })) };
  assert.equal((await recordRoadmapObservation(directory, source.project_id, [renamed], new Date("2026-09-11T10:00:00Z"))).changed, 0);
});

test("baseline does not become a flood of additions; real changes and metadata are separate", async (t) => {
  const directory = await mkdtemp(resolve(tmpdir(), "roadmap-store-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const records = [item(), ...Array.from({ length: 199 }, (_, index) => item(`extra${index}`))];
  assert.deepEqual(await recordRoadmapObservation(directory, source.project_id, records, first), { baseline: true, written: 200, changed: 0 });
  assert.equal(queryRoadmap(await readRoadmapStore(directory), { changedSince: "2026-09-09" }).length, 0);
  assert.equal(queryRoadmap(await readRoadmapStore(directory), { changedSince: "2026-09-09", includeBaseline: true, limit: 300 }).length, 200);
  assert.equal((await recordRoadmapObservation(directory, source.project_id, records, second)).written, 0);
  const updated = records.map((record, index) => index === 0 ? { ...record, status: "Done", itemUpdatedAt: second.toISOString() } : record);
  const result = await recordRoadmapObservation(directory, source.project_id, updated, second);
  assert.equal(result.changed, 1);
  assert.equal(result.written, 1);
  const history = await readRoadmapStore(directory, { history: true });
  assert.equal(history.length, 201);
  assert.deepEqual(history.at(-1)?.changedFields, ["status"]);
  assert.equal(history.at(-1)?.previousRevision, 1);
  const timestampOnly = updated.map((record, index) => index === 0 ? { ...record, contentUpdatedAt: "2026-09-11T09:00:00Z" } : record);
  assert.equal((await recordRoadmapObservation(directory, source.project_id, timestampOnly, new Date("2026-09-11T10:00:00Z"))).changed, 0);
  const latest = await readRoadmapStore(directory);
  assert.equal(queryRoadmap(latest, { changedSince: "2026-09-10" }).length, 1);
  assert.equal(queryRoadmap(latest, { changedSince: "2026-09-11" }).length, 0);
});

test("local query finds exact repository/issue, context, drafts opt-in, and revision history", async (t) => {
  const directory = await mkdtemp(resolve(tmpdir(), "roadmap-query-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const draft = { ...item("draft"), type: "DraftIssue" as const, repository: null, number: null };
  await recordRoadmapObservation(directory, source.project_id, [item(), draft], first);
  await recordRoadmapObservation(directory, source.project_id, [{ ...item(), body: "New accessible scene editor" }, draft], second);
  assert.equal((await runRoadmapQuery(["--repo", "HOME-ASSISTANT/architecture", "--number", "235", "--project", "Home Assistant", "--status", "In progress", "--text", "scene"], directory)).length, 1);
  assert.equal((await runRoadmapQuery([], directory)).length, 1);
  assert.equal((await runRoadmapQuery(["--include-drafts"], directory)).length, 2);
  assert.equal((await runRoadmapQuery(["--id", "roadmap:item1", "--history"], directory)).length, 2);
  assert.equal((await runRoadmapQuery(["--before", second.toISOString()], directory))[0].body, "A public description");
  assert.throws(() => parseRoadmapQueryArguments(["--number", "nan"]));
  assert.throws(() => parseRoadmapQueryArguments(["--made-up"]));
  assert.throws(() => queryRoadmap([], { changedSince: "yesterday-ish" }));
});

test("failed, private, or incomplete board reads never append or imply removals", async (t) => {
  const root = await mkdtemp(resolve(tmpdir(), "roadmap-failure-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = resolve(root, "data/roadmap");
  await recordRoadmapObservation(directory, source.project_id, [item()], first);
  const file = resolve(directory, (await readdir(directory))[0]);
  const before = await readFile(file, "utf8");
  let calls = 0;
  const failure: RoadmapGraphQL = async <T>(): Promise<T> => {
    if (++calls === 2) throw new Error("Network interruption");
    return { node: { id: source.project_id, public: true, url: source.url, items: { nodes: [boardItem("public1")], pageInfo: { hasNextPage: true, endCursor: "next" } } } } as T;
  };
  await assert.rejects(collectRoadmap({ root, source, graphql: failure, observedAt: second }), /Network interruption/);
  assert.equal(await readFile(file, "utf8"), before);
  const privateBoard: RoadmapGraphQL = async <T>(): Promise<T> => ({ node: { id: source.project_id, public: false, url: source.url } }) as T;
  await assert.rejects(fetchRoadmapItems(source, privateBoard), /public project/);
  const stalled: RoadmapGraphQL = async <T>(): Promise<T> => ({ node: { id: source.project_id, public: true, url: source.url, items: { nodes: [], pageInfo: { hasNextPage: true, endCursor: "same" } } } }) as T;
  await assert.rejects(fetchRoadmapItems(source, stalled), /pagination/);
  assert.equal(await readFile(file, "utf8"), before);
});

test("addition and removal are observed changes, never inferred delivery", async (t) => {
  const directory = await mkdtemp(resolve(tmpdir(), "roadmap-delta-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await recordRoadmapObservation(directory, source.project_id, [item()], first);
  const result = await recordRoadmapObservation(directory, source.project_id, [item("new")], second);
  assert.equal(result.changed, 2);
  const latest = await readRoadmapStore(directory);
  assert.equal(queryRoadmap(latest).length, 1);
  assert.equal(queryRoadmap(latest, { includeRemoved: true }).length, 2);
  assert.equal(latest.find((record) => !record.present)?.status, "In progress");
  const history = await readRoadmapStore(directory, { history: true });
  assert.equal(queryRoadmap(history).length, 1);
  assert.equal(queryRoadmap(history, { before: second.toISOString() })[0].id, "roadmap:item1");
  assert.equal(queryRoadmap(latest.map((record) => ({ ...record, status: "Draft" }))).length, 0);
  assert.equal(queryRoadmap(latest.map((record) => ({ ...record, status: "Draft" })), { includeDrafts: true }).length, 1);
  await assert.rejects(recordRoadmapObservation(directory, source.project_id, [], first), /before its latest/);
});
