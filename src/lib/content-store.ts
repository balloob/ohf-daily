import { appendFile, mkdir, readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";

export type ContentKind = "official_post" | "external_coverage";

export interface StoredContentInput {
  id: string;
  kind: ContentKind;
  source: string;
  title: string;
  url: string;
  publishedAt: string;
  updatedAt?: string;
  author?: string | null;
  body: string | null;
  mediaUrls: string[];
}

export interface StoredContent extends StoredContentInput {
  schemaVersion: 1;
  revision: number;
  firstSeenAt: string;
  storedAt: string;
}

export interface ContentQuery {
  kind?: ContentKind;
  source?: string;
  text?: string;
  since?: string;
  before?: string;
  limit?: number;
}

function safeHttpsUrl(value: string): string | undefined {
  try {
    const parsed = new URL(value.replace(/&amp;/g, "&"));
    return parsed.protocol === "https:" && !parsed.username && !parsed.password ? parsed.toString() : undefined;
  } catch {
    return undefined;
  }
}

function safeMediaUrls(values: string[]): string[] {
  return [...new Set(values.flatMap((value) => {
    const url = safeHttpsUrl(value);
    return url ? [url] : [];
  }))];
}

function normalizedKind(value: ContentKind): ContentKind {
  if (value !== "official_post" && value !== "external_coverage") {
    throw new TypeError("Stored content kind must be official_post or external_coverage.");
  }
  return value;
}

function normalizedTimestamp(value: string, field: "publishedAt" | "updatedAt"): string {
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) throw new TypeError(`Stored content ${field} must be a valid timestamp.`);
  return new Date(timestamp).toISOString();
}

function normalizeInput(input: StoredContentInput): StoredContentInput {
  const id = input.id.trim();
  const source = input.source.trim();
  const title = input.title.trim();
  if (!id || !source || !title) throw new TypeError("Stored content is missing required identity fields.");
  const url = safeHttpsUrl(input.url);
  if (!url) throw new TypeError(`Stored content ${id} must have a safe HTTPS URL.`);
  return {
    ...input,
    id,
    kind: normalizedKind(input.kind),
    source,
    title,
    url,
    publishedAt: normalizedTimestamp(input.publishedAt, "publishedAt"),
    updatedAt: input.updatedAt ? normalizedTimestamp(input.updatedAt, "updatedAt") : undefined,
    author: typeof input.author === "string" && input.author.trim() ? input.author.trim() : null,
    body: typeof input.body === "string" ? input.body.trim() || null : null,
    mediaUrls: safeMediaUrls(input.mediaUrls),
  };
}

function semanticRecord(record: StoredContent | StoredContentInput): string {
  return JSON.stringify({
    id: record.id,
    kind: record.kind,
    source: record.source,
    title: record.title,
    url: record.url,
    publishedAt: record.publishedAt,
    updatedAt: record.updatedAt,
    author: record.author,
    body: record.body,
    mediaUrls: record.mediaUrls,
  });
}

function shardFor(record: StoredContentInput): string {
  return record.publishedAt.slice(0, 7);
}

function isStoredContent(value: unknown): value is StoredContent {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<StoredContent>;
  return record.schemaVersion === 1
    && typeof record.id === "string"
    && (record.kind === "official_post" || record.kind === "external_coverage")
    && typeof record.source === "string"
    && typeof record.title === "string"
    && typeof record.url === "string"
    && safeHttpsUrl(record.url) !== undefined
    && typeof record.publishedAt === "string"
    && !Number.isNaN(Date.parse(record.publishedAt))
    && Number.isSafeInteger(record.revision)
    && typeof record.firstSeenAt === "string"
    && typeof record.storedAt === "string"
    && Array.isArray(record.mediaUrls)
    && record.mediaUrls.every((url) => typeof url === "string" && safeHttpsUrl(url) !== undefined);
}

function canonicalContentKey(record: StoredContent): string {
  const url = new URL(record.url);
  url.hash = "";
  url.hostname = url.hostname.toLowerCase();
  url.pathname = url.pathname.replace(/\/+$/, "") || "/";
  return url.toString();
}

function recordRichness(record: StoredContent): number {
  return [record.updatedAt, record.author, record.body, ...record.mediaUrls]
    .filter((value) => value !== undefined && value !== null && value !== "").length;
}

function preferredCanonicalRecord(left: StoredContent, right: StoredContent): StoredContent {
  if (left.kind !== right.kind) return left.kind === "official_post" ? left : right;
  const richness = recordRichness(right) - recordRichness(left);
  if (richness !== 0) return richness > 0 ? right : left;
  const updated = (right.updatedAt ?? right.storedAt).localeCompare(left.updatedAt ?? left.storedAt);
  if (updated !== 0) return updated > 0 ? right : left;
  if (right.storedAt !== left.storedAt) return right.storedAt > left.storedAt ? right : left;
  if (right.revision !== left.revision) return right.revision > left.revision ? right : left;
  return right.id.localeCompare(left.id) > 0 ? right : left;
}

export async function readContentStore(directory: string): Promise<StoredContent[]> {
  let files: string[];
  try {
    files = (await readdir(directory)).filter((file) => /^\d{4}-\d{2}\.ndjson$/.test(file)).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }

  const latest = new Map<string, StoredContent>();
  for (const file of files) {
    const lines = (await readFile(resolve(directory, file), "utf8")).split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index].trim();
      if (!line) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        throw new Error(`Invalid JSON in ${file}:${index + 1}.`);
      }
      if (!isStoredContent(parsed)) throw new Error(`Invalid content record in ${file}:${index + 1}.`);
      const previous = latest.get(parsed.id);
      if (!previous || parsed.revision > previous.revision || (parsed.revision === previous.revision && parsed.storedAt > previous.storedAt)) {
        latest.set(parsed.id, parsed);
      }
    }
  }

  const canonical = new Map<string, StoredContent>();
  for (const record of latest.values()) {
    const key = canonicalContentKey(record);
    const previous = canonical.get(key);
    canonical.set(key, previous ? preferredCanonicalRecord(previous, record) : record);
  }
  return [...canonical.values()];
}

function mergeContentInputs(previous: StoredContentInput, incoming: StoredContentInput): StoredContentInput {
  return normalizeInput({
    ...previous,
    ...incoming,
    updatedAt: incoming.updatedAt ?? previous.updatedAt,
    author: incoming.author ?? previous.author,
    body: incoming.body ?? previous.body,
    mediaUrls: [...previous.mediaUrls, ...incoming.mediaUrls],
  });
}

export async function upsertContentStore(
  directory: string,
  inputs: StoredContentInput[],
  observedAt = new Date(),
): Promise<{ written: number; unchanged: number }> {
  if (Number.isNaN(observedAt.getTime())) throw new TypeError("Store observation time must be valid.");
  const existing = new Map((await readContentStore(directory)).map((record) => [record.id, record]));
  const pending = new Map<string, StoredContentInput>();
  for (const input of inputs) {
    const normalized = normalizeInput(input);
    const priorPending = pending.get(normalized.id);
    pending.set(normalized.id, priorPending ? mergeContentInputs(priorPending, normalized) : normalized);
  }

  const timestamp = observedAt.toISOString();
  const appends = new Map<string, StoredContent[]>();
  let unchanged = 0;
  for (const input of pending.values()) {
    const previous = existing.get(input.id);
    const merged = previous ? mergeContentInputs(previous, input) : input;
    if (previous && semanticRecord(previous) === semanticRecord(merged)) {
      unchanged += 1;
      continue;
    }
    const record: StoredContent = {
      ...merged,
      schemaVersion: 1,
      revision: (previous?.revision ?? 0) + 1,
      firstSeenAt: previous?.firstSeenAt ?? timestamp,
      storedAt: timestamp,
    };
    const shard = shardFor(record);
    appends.set(shard, [...(appends.get(shard) ?? []), record]);
  }

  await mkdir(directory, { recursive: true });
  await Promise.all(
    [...appends].map(([shard, records]) => appendFile(resolve(directory, `${shard}.ndjson`), `${records.map((record) => JSON.stringify(record)).join("\n")}\n`)),
  );
  return { written: [...appends.values()].reduce((total, records) => total + records.length, 0), unchanged };
}

function boundaryTimestamp(value: string | undefined, option: "since" | "before"): number | undefined {
  if (!value) return undefined;
  const normalized = /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00Z` : value;
  const result = Date.parse(normalized);
  if (Number.isNaN(result)) throw new TypeError(`${option} must be a valid YYYY-MM-DD date or ISO timestamp.`);
  return result;
}

export function queryContent(records: StoredContent[], query: ContentQuery): StoredContent[] {
  const source = query.source?.trim().toLowerCase();
  const text = query.text?.trim().toLowerCase();
  const since = boundaryTimestamp(query.since, "since");
  const before = boundaryTimestamp(query.before, "before");
  const limit = query.limit ?? 100;
  if (!Number.isSafeInteger(limit) || limit < 1) throw new TypeError("limit must be a positive integer.");

  return records
    .filter((record) => !query.kind || record.kind === query.kind)
    .filter((record) => !source || record.source.toLowerCase() === source)
    .filter((record) => !text || `${record.title}\n${record.body ?? ""}\n${record.source}\n${record.author ?? ""}`.toLowerCase().includes(text))
    .filter((record) => since === undefined || Date.parse(record.publishedAt) >= since)
    .filter((record) => before === undefined || Date.parse(record.publishedAt) < before)
    .sort((left, right) => right.publishedAt.localeCompare(left.publishedAt) || right.id.localeCompare(left.id))
    .slice(0, limit);
}
