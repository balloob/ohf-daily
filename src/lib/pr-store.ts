import { appendFile, mkdir, readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { ContributorProfile, FirstContribution } from "./contributors";

export interface PullRequestStats {
  additions?: number;
  deletions?: number;
  changedFiles?: number;
  comments?: number;
  reviewComments?: number;
}

export interface StoredPullRequestInput {
  id: number;
  number?: number;
  url: string;
  apiUrl?: string;
  repository: string;
  organization: string;
  title: string;
  body: string | null;
  author: string;
  authorProfile?: ContributorProfile;
  mergedAt: string | null;
  githubUpdatedAt?: string;
  labels: string[];
  mediaUrls: string[];
  reviewers: string[];
  approvers: string[];
  firstContribution?: FirstContribution;
  isFirstContribution?: boolean;
  stats: PullRequestStats;
  isDependency: boolean;
}

export interface StoredPullRequest extends StoredPullRequestInput {
  schemaVersion: 1;
  revision: number;
  firstSeenAt: string;
  storedAt: string;
}

export interface PullRequestQuery {
  repository?: string;
  author?: string;
  label?: string;
  text?: string;
  since?: string;
  before?: string;
  limit?: number;
}

function normalizedStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim().toLowerCase()).filter(Boolean))].sort();
}

function safeMediaUrls(values: string[]): string[] {
  const urls = values.flatMap((value) => {
    try {
      const parsed = new URL(value.replace(/&amp;/g, "&"));
      return parsed.protocol === "https:" && !parsed.username && !parsed.password ? [parsed.toString()] : [];
    } catch {
      return [];
    }
  });
  return [...new Set(urls)];
}

function finiteCount(value: number | undefined): number | undefined {
  return value !== undefined && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function normalizedContributorProfile(profile: ContributorProfile | undefined): ContributorProfile | undefined {
  if (!profile?.login || !profile.avatarUrl || !profile.profileUrl) return undefined;
  const urls = [profile.avatarUrl, profile.profileUrl].map((value) => {
    try {
      const url = new URL(value);
      return url.protocol === "https:" && !url.username && !url.password ? url.toString() : undefined;
    } catch {
      return undefined;
    }
  });
  if (!urls[0] || !urls[1]) return undefined;
  return {
    login: profile.login.trim(),
    name: typeof profile.name === "string" && profile.name.trim() ? profile.name.trim() : null,
    avatarUrl: urls[0],
    profileUrl: urls[1],
  };
}

function normalizeInput(input: StoredPullRequestInput): StoredPullRequestInput {
  if (!Number.isSafeInteger(input.id) || input.id < 1) throw new TypeError("Stored pull request id must be a positive safe integer.");
  if (!input.url || !input.repository || !input.title) throw new TypeError(`Stored pull request ${input.id} is missing required identity fields.`);
  if (input.mergedAt !== null && Number.isNaN(Date.parse(input.mergedAt))) throw new TypeError(`Stored pull request ${input.id} has an invalid mergedAt value.`);
  return {
    ...input,
    number: input.number !== undefined && Number.isSafeInteger(input.number) && input.number > 0 ? input.number : undefined,
    repository: input.repository.trim(),
    organization: input.organization.trim(),
    title: input.title.trim(),
    author: input.author.trim() || "ghost",
    authorProfile: normalizedContributorProfile(input.authorProfile),
    labels: normalizedStrings(input.labels),
    mediaUrls: safeMediaUrls(input.mediaUrls),
    reviewers: [...new Map(input.reviewers.filter(Boolean).map((login) => [login.toLowerCase(), login])).values()].sort((a, b) => a.localeCompare(b)),
    approvers: [...new Map(input.approvers.filter(Boolean).map((login) => [login.toLowerCase(), login])).values()].sort((a, b) => a.localeCompare(b)),
    stats: {
      additions: finiteCount(input.stats.additions),
      deletions: finiteCount(input.stats.deletions),
      changedFiles: finiteCount(input.stats.changedFiles),
      comments: finiteCount(input.stats.comments),
      reviewComments: finiteCount(input.stats.reviewComments),
    },
  };
}

function semanticRecord(record: StoredPullRequest | StoredPullRequestInput): string {
  return JSON.stringify({
    id: record.id,
    number: record.number,
    url: record.url,
    apiUrl: record.apiUrl,
    repository: record.repository,
    organization: record.organization,
    title: record.title,
    body: record.body,
    author: record.author,
    authorProfile: record.authorProfile,
    mergedAt: record.mergedAt,
    githubUpdatedAt: record.githubUpdatedAt,
    labels: record.labels,
    mediaUrls: record.mediaUrls,
    reviewers: record.reviewers,
    approvers: record.approvers,
    firstContribution: record.firstContribution,
    isFirstContribution: record.isFirstContribution,
    stats: record.stats,
    isDependency: record.isDependency,
  });
}

function shardFor(record: StoredPullRequestInput, fallback: Date): string {
  const date = record.mergedAt ? new Date(record.mergedAt) : fallback;
  return date.toISOString().slice(0, 7);
}

function isStoredPullRequest(value: unknown): value is StoredPullRequest {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<StoredPullRequest>;
  return record.schemaVersion === 1 && Number.isSafeInteger(record.id) && typeof record.repository === "string" && typeof record.title === "string" && typeof record.storedAt === "string";
}

function canonicalPullRequestKey(record: StoredPullRequest): string {
  const repository = record.repository.trim().toLowerCase();
  if (record.number !== undefined) return `${repository}#${record.number}`;
  try {
    const url = new URL(record.url);
    url.hash = "";
    url.search = "";
    url.hostname = url.hostname.toLowerCase();
    url.pathname = url.pathname.replace(/\/+$/, "").toLowerCase();
    return url.toString();
  } catch {
    return record.url.trim().toLowerCase();
  }
}

function recordRichness(record: StoredPullRequest): number {
  return [
    record.apiUrl,
    record.body,
    record.mergedAt,
    record.githubUpdatedAt,
    record.authorProfile,
    record.firstContribution,
    record.isFirstContribution,
    ...record.mediaUrls,
    ...record.reviewers,
    ...record.approvers,
    ...Object.values(record.stats),
  ].filter((value) => value !== undefined && value !== null && value !== "").length;
}

function preferredCanonicalRecord(left: StoredPullRequest, right: StoredPullRequest): StoredPullRequest {
  const richness = recordRichness(right) - recordRichness(left);
  if (richness !== 0) return richness > 0 ? right : left;
  const updated = (right.githubUpdatedAt ?? right.storedAt).localeCompare(left.githubUpdatedAt ?? left.storedAt);
  if (updated !== 0) return updated > 0 ? right : left;
  if (right.storedAt !== left.storedAt) return right.storedAt > left.storedAt ? right : left;
  if (right.revision !== left.revision) return right.revision > left.revision ? right : left;
  return right.id > left.id ? right : left;
}

export async function readPullRequestStore(directory: string): Promise<StoredPullRequest[]> {
  let files: string[];
  try {
    files = (await readdir(directory)).filter((file) => /^\d{4}-\d{2}\.ndjson$/.test(file)).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }

  const latest = new Map<number, StoredPullRequest>();
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
      if (!isStoredPullRequest(parsed)) throw new Error(`Invalid pull request record in ${file}:${index + 1}.`);
      const previous = latest.get(parsed.id);
      if (!previous || parsed.revision > previous.revision || (parsed.revision === previous.revision && parsed.storedAt > previous.storedAt)) {
        latest.set(parsed.id, parsed);
      }
    }
  }
  const canonical = new Map<string, StoredPullRequest>();
  for (const record of latest.values()) {
    const key = canonicalPullRequestKey(record);
    const previous = canonical.get(key);
    canonical.set(key, previous ? preferredCanonicalRecord(previous, record) : record);
  }
  return [...canonical.values()];
}

export async function upsertPullRequestStore(
  directory: string,
  inputs: StoredPullRequestInput[],
  observedAt = new Date(),
): Promise<{ written: number; unchanged: number }> {
  if (Number.isNaN(observedAt.getTime())) throw new TypeError("Store observation time must be valid.");
  const existing = new Map((await readPullRequestStore(directory)).map((record) => [record.id, record]));
  const pending = new Map<number, StoredPullRequestInput>();
  for (const input of inputs) {
    const normalized = normalizeInput(input);
    const priorPending = pending.get(normalized.id);
    pending.set(normalized.id, priorPending ? mergePullRequestInputs(priorPending, normalized) : normalized);
  }

  const timestamp = observedAt.toISOString();
  const appends = new Map<string, StoredPullRequest[]>();
  let unchanged = 0;
  for (const input of pending.values()) {
    const previous = existing.get(input.id);
    const merged = previous ? mergePullRequestInputs(previous, input) : input;
    if (previous && semanticRecord(previous) === semanticRecord(merged)) {
      unchanged += 1;
      continue;
    }
    const record: StoredPullRequest = {
      ...merged,
      schemaVersion: 1,
      revision: (previous?.revision ?? 0) + 1,
      firstSeenAt: previous?.firstSeenAt ?? timestamp,
      storedAt: timestamp,
    };
    const shard = shardFor(record, observedAt);
    appends.set(shard, [...(appends.get(shard) ?? []), record]);
  }

  await mkdir(directory, { recursive: true });
  await Promise.all(
    [...appends].map(([shard, records]) => appendFile(resolve(directory, `${shard}.ndjson`), records.map((record) => JSON.stringify(record)).join("\n") + "\n")),
  );
  return { written: [...appends.values()].reduce((total, records) => total + records.length, 0), unchanged };
}

function mergePullRequestInputs(previous: StoredPullRequestInput, incoming: StoredPullRequestInput): StoredPullRequestInput {
  return normalizeInput({
    ...previous,
    ...incoming,
    number: incoming.number ?? previous.number,
    apiUrl: incoming.apiUrl ?? previous.apiUrl,
    mergedAt: incoming.mergedAt ?? previous.mergedAt,
    githubUpdatedAt: incoming.githubUpdatedAt ?? previous.githubUpdatedAt,
    reviewers: [...previous.reviewers, ...incoming.reviewers],
    approvers: [...previous.approvers, ...incoming.approvers],
    authorProfile: incoming.authorProfile ?? previous.authorProfile,
    firstContribution: incoming.firstContribution ?? previous.firstContribution,
    isFirstContribution: incoming.isFirstContribution ?? previous.isFirstContribution,
    stats: { ...previous.stats, ...Object.fromEntries(Object.entries(incoming.stats).filter(([, value]) => value !== undefined)) },
  });
}

function boundaryTimestamp(value: string | undefined, option: "--since" | "--before"): number | undefined {
  if (!value) return undefined;
  const normalized = /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00Z` : value;
  const result = Date.parse(normalized);
  if (Number.isNaN(result)) throw new TypeError(`${option} must be a valid YYYY-MM-DD date or ISO timestamp.`);
  return result;
}

export function queryPullRequests(records: StoredPullRequest[], query: PullRequestQuery): StoredPullRequest[] {
  const repository = query.repository?.trim().toLowerCase();
  const author = query.author?.trim().toLowerCase();
  const label = query.label?.trim().toLowerCase();
  const text = query.text?.trim().toLowerCase();
  const since = boundaryTimestamp(query.since, "--since");
  const before = boundaryTimestamp(query.before, "--before");
  const limit = query.limit ?? 100;
  if (!Number.isSafeInteger(limit) || limit < 1) throw new TypeError("--limit must be a positive integer.");

  return records
    .filter((record) => !repository || record.repository.toLowerCase() === repository)
    .filter((record) => !author || record.author.toLowerCase() === author)
    .filter((record) => !label || record.labels.includes(label))
    .filter((record) => !text || `${record.title}\n${record.body ?? ""}\n${record.repository}\n${record.author}\n${record.labels.join("\n")}`.toLowerCase().includes(text))
    .filter((record) => since === undefined || (record.mergedAt !== null && Date.parse(record.mergedAt) >= since))
    .filter((record) => before === undefined || (record.mergedAt !== null && Date.parse(record.mergedAt) < before))
    .sort((left, right) => (right.mergedAt ?? "").localeCompare(left.mergedAt ?? "") || right.id - left.id)
    .slice(0, limit);
}
