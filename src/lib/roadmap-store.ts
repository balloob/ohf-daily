import { appendFile, mkdir, readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";

export interface RoadmapComment {
  id: string;
  url: string;
  author: string | null;
  authorName?: string | null;
  body: string;
  createdAt: string;
  updatedAt: string;
}

export interface RoadmapItem {
  id: string;
  itemId: string;
  projectId: string;
  projectUrl: string;
  type: "Issue" | "DraftIssue";
  title: string;
  body: string;
  url: string;
  author?: { login: string; name: string | null };
  repository: string | null;
  number: number | null;
  status: string | null;
  mainProject: string | null;
  area: string | null;
  priority: string | null;
  deliveryStatus: string | null;
  itemCreatedAt: string;
  itemUpdatedAt: string;
  contentCreatedAt: string;
  contentUpdatedAt: string;
  comments: RoadmapComment[];
  commentCount: number;
}

export interface RoadmapSnapshot extends RoadmapItem {
  schemaVersion: 1;
  revision: number;
  previousRevision: number | null;
  observedAt: string;
  firstSeenAt: string;
  /** Observation time of the last actual change; never a claimed GitHub event date. */
  lastChangedAt: string | null;
  changeKind: "baseline" | "added" | "updated" | "removed";
  changedFields: string[];
  present: boolean;
}

interface RoadmapObservation {
  schemaVersion: 1;
  projectId: string;
  observedAt: string;
  baseline: boolean;
  observedItemIds: string[];
  records: RoadmapSnapshot[];
}

const semanticFields = ["title", "body", "url", "repository", "number", "status", "mainProject", "area", "priority", "deliveryStatus", "comments", "commentCount"] as const;

function semanticValue(item: RoadmapItem, field: typeof semanticFields[number]): unknown {
  // Editing timestamps alone do not prove a changed statement or changed plan.
  return field === "comments" ? item.comments.map(({ id, body, author, url }) => ({ id, body, author, url })) : item[field];
}

export function changedRoadmapFields(before: RoadmapItem, after: RoadmapItem): string[] {
  return semanticFields.filter((field) => JSON.stringify(semanticValue(before, field)) !== JSON.stringify(semanticValue(after, field)));
}

async function readObservations(directory: string): Promise<RoadmapObservation[]> {
  let files: string[];
  try { files = (await readdir(directory)).filter((file) => /^\d{4}-\d{2}\.ndjson$/.test(file)).sort(); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  const observations: RoadmapObservation[] = [];
  for (const file of files) {
    const lines = (await readFile(resolve(directory, file), "utf8")).split(/\r?\n/);
    for (const [index, line] of lines.entries()) {
      if (!line.trim()) continue;
      let value: RoadmapObservation;
      try { value = JSON.parse(line); }
      catch { throw new Error(`Invalid roadmap JSON in ${file}:${index + 1}.`); }
      if (value.schemaVersion !== 1 || !value.projectId || !Array.isArray(value.records) || !Array.isArray(value.observedItemIds)) {
        throw new Error(`Invalid roadmap observation in ${file}:${index + 1}.`);
      }
      observations.push(value);
    }
  }
  return observations.sort((a, b) => a.observedAt.localeCompare(b.observedAt));
}

export async function readRoadmapStore(directory: string, options: { history?: boolean } = {}): Promise<RoadmapSnapshot[]> {
  const records = (await readObservations(directory)).flatMap((observation) => observation.records);
  if (options.history) return records;
  const latest = new Map<string, RoadmapSnapshot>();
  for (const record of records) latest.set(record.id, record);
  return [...latest.values()];
}

/** Call only after a complete successful public-board read, including every page. */
export async function recordRoadmapObservation(directory: string, projectId: string, items: RoadmapItem[], observedAt = new Date()): Promise<{ baseline: boolean; written: number; changed: number }> {
  if (Number.isNaN(observedAt.getTime())) throw new TypeError("Roadmap observation time must be valid.");
  if (items.some((item) => item.projectId !== projectId) || new Set(items.map((item) => item.id)).size !== items.length) throw new Error("Invalid roadmap item identities.");
  const observations = await readObservations(directory);
  const previousObservations = observations.filter((observation) => observation.projectId === projectId);
  const timestamp = observedAt.toISOString();
  if (previousObservations.some((observation) => observation.observedAt > timestamp)) throw new Error("Cannot append a roadmap observation before its latest snapshot.");
  const baseline = previousObservations.length === 0;
  const previous = new Map(previousObservations.flatMap((observation) => observation.records).map((record) => [record.id, record]));
  const records: RoadmapSnapshot[] = [];
  for (const item of items) {
    const before = previous.get(item.id);
    const changedFields = before ? changedRoadmapFields(before, item) : [];
    if (before && !before.present) changedFields.push("present");
    const metadataChanged = before && (before.itemUpdatedAt !== item.itemUpdatedAt || before.contentUpdatedAt !== item.contentUpdatedAt || JSON.stringify(before.comments) !== JSON.stringify(item.comments) || JSON.stringify(before.author) !== JSON.stringify(item.author));
    if (before && before.present && changedFields.length === 0 && !metadataChanged) continue;
    const changeKind = baseline ? "baseline" : !before ? "added" : "updated";
    records.push({ ...item, schemaVersion: 1, revision: (before?.revision ?? 0) + 1, previousRevision: before?.revision ?? null,
      observedAt: timestamp, firstSeenAt: before?.firstSeenAt ?? timestamp, present: true,
      changeKind, changedFields,
      lastChangedAt: baseline ? null : !before || changedFields.length ? timestamp : before.lastChangedAt,
    });
  }
  const present = new Set(items.map((item) => item.id));
  for (const before of previous.values()) {
    if (before.present && !present.has(before.id)) records.push({ ...before, revision: before.revision + 1, previousRevision: before.revision,
      observedAt: timestamp, lastChangedAt: timestamp, present: false, changeKind: "removed", changedFields: ["present"] });
  }
  const observation: RoadmapObservation = { schemaVersion: 1, projectId, observedAt: timestamp, baseline, observedItemIds: [...present].sort(), records };
  await mkdir(directory, { recursive: true });
  // One append commits the complete observation; failed network reads never get here.
  await appendFile(resolve(directory, `${timestamp.slice(0, 7)}.ndjson`), `${JSON.stringify(observation)}\n`);
  return { baseline, written: records.length, changed: records.filter((record) => record.changeKind !== "baseline" && (record.changeKind === "added" || record.changedFields.length > 0)).length };
}

export interface RoadmapQuery {
  id?: string;
  repository?: string;
  number?: number;
  status?: string;
  project?: string;
  text?: string;
  changedSince?: string;
  before?: string;
  includeDrafts?: boolean;
  includeBaseline?: boolean;
  includeRemoved?: boolean;
  history?: boolean;
  limit?: number;
}

export function queryRoadmap(records: RoadmapSnapshot[], query: RoadmapQuery = {}): RoadmapSnapshot[] {
  const since = query.changedSince ? Date.parse(query.changedSince) : undefined;
  const before = query.before ? Date.parse(query.before) : undefined;
  if ((since !== undefined && Number.isNaN(since)) || (before !== undefined && Number.isNaN(before))) throw new TypeError("Roadmap dates must be valid dates or ISO timestamps.");
  const limit = query.limit ?? 100;
  if (!Number.isSafeInteger(limit) || limit < 1) throw new TypeError("Roadmap limit must be a positive integer.");
  const equal = (left: string | null, right: string | undefined) => !right || left?.toLowerCase() === right.toLowerCase();
  const inTime = records.filter((record) => before === undefined || Date.parse(record.observedAt) < before);
  const latest = new Map<string, RoadmapSnapshot>();
  for (const record of inTime) {
    const previous = latest.get(record.id);
    if (!previous || record.revision > previous.revision) latest.set(record.id, record);
  }
  return (query.history ? inTime : [...latest.values()]).filter((record) => (!query.id || record.id === query.id)
    && (query.includeDrafts || (record.type === "Issue" && record.status?.toLowerCase() !== "draft"))
    && (query.includeRemoved || record.present)
    && equal(record.repository, query.repository)
    && (query.number === undefined || record.number === query.number)
    && equal(record.status, query.status)
    && equal(record.mainProject, query.project)
    && (!query.text || `${record.title}\n${record.body}\n${record.comments.map((comment) => comment.body).join("\n")}`.toLowerCase().includes(query.text.toLowerCase()))
    && (before === undefined || Date.parse(record.observedAt) < before)
    && (since === undefined || (record.lastChangedAt !== null && Date.parse(record.lastChangedAt) >= since && (!query.history || record.changeKind === "added" || record.changedFields.length > 0)) || (query.includeBaseline && record.changeKind === "baseline" && Date.parse(record.observedAt) >= since)))
    .sort((a, b) => b.observedAt.localeCompare(a.observedAt) || b.revision - a.revision || a.id.localeCompare(b.id))
    .slice(0, limit);
}
