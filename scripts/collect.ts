import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { buildReleaseCalendar, type ReleaseCycle } from "../src/lib/releases";
import { collectContentFeeds, type FeedSourceConfig } from "../src/lib/feed-collector";
import { collectReleasePreviews, type ActiveReleaseTarget, type ReleasePreviewSourceConfig } from "../src/lib/release-previews";
import { isBotLogin, loadContributorCache, lookupContributorDetails, type ContributorCache } from "../src/lib/contributors";
import { queryPullRequests, readPullRequestStore, upsertPullRequestStore, type StoredPullRequest, type StoredPullRequestInput } from "../src/lib/pr-store";
import type { DependencyItem, Edition, LandedRelease, ProjectPulseItem, PullRequestStory, ReleasePreview, StoryKind } from "../src/lib/types";

interface OrganizationConfig {
  slug: string;
  name: string;
  enabled: boolean;
  weight: number;
  featured_repositories: string[];
}

interface ReleaseSourceConfig {
  repository: string;
  product: string;
  accent: string;
  include_prereleases?: boolean;
}

export interface SourcesConfig {
  window_hours: number;
  timezone: string;
  max_prs_per_organization: number;
  front_page_stories: number;
  briefs_limit: number;
  release_horizon_days?: number;
  feed_sources?: FeedSourceConfig[];
  release_sources?: ReleaseSourceConfig[];
  release_preview_sources?: ReleasePreviewSourceConfig[];
  organizations: OrganizationConfig[];
  editorial: {
    ignore_labels: string[];
    feature_labels: string[];
    breaking_labels: string[];
    dependency_authors: string[];
    high_signal_terms: string[];
  };
  release_cycles: ReleaseCycle[];
}

export interface SearchItem {
  id: number;
  number: number;
  title: string;
  html_url: string;
  body: string | null;
  user: { login: string } | null;
  repository_url: string;
  labels: Array<{ name: string }>;
  updated_at: string;
  comments: number;
  pull_request?: { url: string; merged_at?: string | null };
}

interface SearchResponse {
  total_count: number;
  incomplete_results: boolean;
  items: SearchItem[];
}

interface PullDetail {
  id: number;
  number: number;
  title: string;
  html_url: string;
  body: string | null;
  user: { login: string } | null;
  labels: Array<{ name: string }>;
  merged_at: string | null;
  updated_at: string;
  additions: number;
  deletions: number;
  changed_files: number;
  comments: number;
  review_comments: number;
  base: { repo: { full_name: string } };
  head?: { sha: string };
}

export interface PullFile {
  filename: string;
  status: string;
  raw_url?: string;
}

export interface GitHubRelease {
  id?: number;
  name?: string | null;
  body?: string | null;
  published_at: string | null;
  html_url: string;
  tag_name: string;
  draft?: boolean;
  prerelease?: boolean;
}

export interface PullReview {
  state: string;
  submitted_at: string | null;
  user: { login: string } | null;
}

export interface CacheEntry {
  fetchedAt: string;
  etag?: string;
  data: unknown;
}

export interface CacheFile {
  version: 1;
  entries: Record<string, CacheEntry>;
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const configPath = resolve(root, "data/sources.yaml");
const cachePath = resolve(root, "data/cache/github.json");
const editionDirectory = resolve(root, "data/editions");
const pullRequestDirectory = resolve(root, "data/prs");
const contributorCachePath = resolve(root, "data/cache/contributors.json");
const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
const apiVersion = "2022-11-28";

function getArgument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function hasArgument(name: string): boolean {
  return process.argv.includes(name);
}

function zonedParts(date: Date, timeZone: string): Record<"year" | "month" | "day" | "hour" | "minute" | "second", number> {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, Number(part.value)]));
  return values as Record<"year" | "month" | "day" | "hour" | "minute" | "second", number>;
}

export function dateInTimeZone(date: Date, timeZone: string): string {
  if (Number.isNaN(date.getTime())) throw new TypeError("Edition time must be a valid date.");
  const { year, month, day } = zonedParts(date, timeZone);
  return `${year.toString().padStart(4, "0")}-${month.toString().padStart(2, "0")}-${day.toString().padStart(2, "0")}`;
}

function localMidnightToUtc(year: number, month: number, day: number, timeZone: string): Date {
  const target = Date.UTC(year, month - 1, day);
  let candidate = target;
  // Iterating also handles an offset change near the requested date.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const parts = zonedParts(new Date(candidate), timeZone);
    const represented = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
    candidate -= represented - target;
  }
  return new Date(candidate);
}

export function endOfEditionDate(date: string, timeZone: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new TypeError("--date must use YYYY-MM-DD format.");
  const parsed = new Date(`${date}T12:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) {
    throw new TypeError("--date must be a valid calendar date.");
  }
  parsed.setUTCDate(parsed.getUTCDate() + 1);
  return new Date(localMidnightToUtc(parsed.getUTCFullYear(), parsed.getUTCMonth() + 1, parsed.getUTCDate(), timeZone).getTime() - 1);
}

export function startOfEditionDate(date: string, timeZone: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new TypeError("Date must use YYYY-MM-DD format.");
  const parsed = new Date(`${date}T12:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) throw new TypeError("Date must be a valid calendar date.");
  return localMidnightToUtc(parsed.getUTCFullYear(), parsed.getUTCMonth() + 1, parsed.getUTCDate(), timeZone);
}

export function reportingWindow(now: Date, requestedDate: string | undefined, timeZone: string, hours: number): {
  editionDate: string;
  start: Date;
  end: Date;
} {
  if (!Number.isFinite(hours) || hours <= 0) throw new TypeError("window_hours must be a positive number.");
  if (Number.isNaN(now.getTime())) throw new TypeError("Reporting end must be a valid date.");
  const currentDate = dateInTimeZone(now, timeZone);
  let end: Date;
  if (requestedDate) {
    const requestedEnd = endOfEditionDate(requestedDate, timeZone);
    if (requestedDate > currentDate) throw new TypeError("--date cannot be in the future.");
    end = requestedDate === currentDate ? new Date(now) : requestedEnd;
  } else {
    end = new Date(now);
  }
  if (Number.isNaN(end.getTime())) throw new TypeError("Reporting end must be a valid date.");
  return {
    editionDate: requestedDate ?? currentDate,
    start: new Date(end.getTime() - hours * 3_600_000),
    end,
  };
}

async function loadYaml<T>(path: string): Promise<T> {
  return YAML.parse(await readFile(path, "utf8")) as T;
}

async function loadCache(): Promise<CacheFile> {
  try {
    const parsed = JSON.parse(await readFile(cachePath, "utf8")) as Partial<CacheFile>;
    if (parsed.version === 1 && parsed.entries && typeof parsed.entries === "object") {
      return parsed as CacheFile;
    }
    console.warn("Ignoring an unsupported GitHub cache file.");
  } catch {
    // A cache is an optimization. Missing or malformed cache data must not stop an edition.
  }
  return { version: 1, entries: {} };
}

async function saveJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`);
  await rename(temporaryPath, path);
}

export class GitHubClient {
  private lastSearchRequestAt = 0;

  constructor(
    private cache: CacheFile,
    private fetcher: typeof fetch = fetch,
    private now: () => Date = () => new Date(),
  ) {}

  async get<T>(url: string, options: { immutable?: boolean; maxAgeMinutes?: number } = {}): Promise<T> {
    const cached = this.cache.entries[url];
    const age = cached ? this.now().getTime() - new Date(cached.fetchedAt).getTime() : Number.POSITIVE_INFINITY;
    if (cached && (options.immutable || age < (options.maxAgeMinutes ?? 30) * 60_000)) {
      return cached.data as T;
    }

    const headers: Record<string, string> = {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": apiVersion,
      "User-Agent": "ohf-daily",
    };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (cached?.etag) headers["If-None-Match"] = cached.etag;

    if (/^https:\/\/api\.github\.com\/search\//.test(url)) {
      const interval = token ? 2_100 : 6_500;
      const wait = interval - (Date.now() - this.lastSearchRequestAt);
      if (wait > 0) await new Promise((resolveWait) => setTimeout(resolveWait, wait));
      this.lastSearchRequestAt = Date.now();
    }

    let response: Response | undefined;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      response = await this.fetcher(url, { headers, signal: AbortSignal.timeout(30_000) });
      if (![403, 429, 500, 502, 503, 504].includes(response.status) || attempt > 0) break;
      const retryAfter = Number(response.headers.get("retry-after"));
      const resetAt = Number(response.headers.get("x-ratelimit-reset")) * 1_000;
      const resetDelay = Number.isFinite(resetAt) ? resetAt - Date.now() : Number.NaN;
      const delay = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1_000 : resetDelay;
      if (!Number.isFinite(delay) || delay <= 0 || delay > 60_000) break;
      await new Promise((resolveWait) => setTimeout(resolveWait, delay));
    }
    if (!response) throw new Error(`GitHub request did not return a response for ${url}.`);
    if (response.status === 304 && cached) {
      cached.fetchedAt = this.now().toISOString();
      return cached.data as T;
    }
    if (!response.ok) {
      if (cached) {
        console.warn(`GitHub returned ${response.status} for ${url}; using cached response.`);
        return cached.data as T;
      }
      const detail = (await response.text()).slice(0, 300);
      throw new Error(`GitHub returned ${response.status} for ${url}: ${detail}`);
    }

    const data = (await response.json()) as T;
    this.cache.entries[url] = {
      fetchedAt: this.now().toISOString(),
      etag: response.headers.get("etag") ?? undefined,
      data,
    };
    return data;
  }
}

export function repositoryFromApiUrl(url: string): string {
  return url.split("/repos/")[1] ?? basename(url);
}

export function stripMarkdown(value: string): string {
  return value
    .replace(/<!--[^]*?-->/g, " ")
    .replace(/```[^]*?```/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^\s*[-*+]\s+\[[ xX]\]\s*/gm, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/^#+\s+/gm, "")
    .replace(/[>*_`~|-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function truncateAtWord(value: string, limit: number): string {
  if (value.length <= limit) return value;
  const candidate = value.slice(0, limit + 1);
  const boundary = candidate.lastIndexOf(" ");
  return `${candidate.slice(0, boundary > limit * 0.65 ? boundary : limit).trim()}…`;
}

export function sentenceSummary(body: string | null, title: string): string {
  const text = stripMarkdown(body ?? "")
    .replace(/^(summary|description|what does this pr do|proposed change)\s*:?\s*/i, "")
    .trim();
  const useful = text.length > 28 ? text : title.replace(/^(feat|fix|docs|refactor|chore)(\([^)]*\))?:\s*/i, "");
  const sentence = useful.match(/^.{30,220}?[.!?](?=\s|$)/)?.[0] ?? useful.slice(0, 190);
  return sentence.length < useful.length && !/[.!?]$/.test(sentence) ? truncateAtWord(useful, 190) : sentence.trim();
}

export function extractMediaUrls(body: string | null): string[] {
  if (!body) return [];
  const candidates: string[] = [];
  for (const match of body.matchAll(/!\[[^\]]*\]\(\s*<?(https:\/\/[^>\s)]+)>?(?:\s+["'][^"']*["'])?\s*\)/gi)) candidates.push(match[1]);
  for (const match of body.matchAll(/<(?:img|video|source)[^>]+(?:src|poster)=["'](https:\/\/[^"']+)["']/gi)) candidates.push(match[1]);
  for (const match of body.matchAll(/https:\/\/[^\s<>()"']+/gi)) {
    if (/github\.com\/user-attachments\/|user-images\.githubusercontent\.com\/|\.(?:avif|gif|jpe?g|png|webp|mp4|mov|webm)(?:[?#]|$)/i.test(match[0])) candidates.push(match[0]);
  }
  return [...new Set(candidates.flatMap((candidate) => {
    try {
      const parsed = new URL(candidate.replace(/[.,;:!?]+$/, "").replace(/&amp;/g, "&"));
      return parsed.protocol === "https:" && !parsed.username && !parsed.password ? [parsed.toString()] : [];
    } catch {
      return [];
    }
  }))];
}

const committedMediaExtension = /\.(?:avif|gif|jpe?g|png|webp|mp4|mov|webm)$/i;
const mediaInspectionSignal = /\b(?:screen\s*shots?|screen\s+recordings?|snapshots?|visual\s+(?:changes?|diffs?|tests?)|test\s+artifacts?|artifacts?|media|videos?|animated\s+gifs?)\b/i;

/**
 * PR file lists cost an additional API request, so inspect them only when the
 * author explicitly signals that visual evidence exists.
 */
export function shouldInspectPullFiles(title: string, body: string | null): boolean {
  return mediaInspectionSignal.test(`${title}\n${body ?? ""}`);
}

/** Builds immutable raw URLs for safe, non-deleted media committed in a PR. */
export function committedMediaUrls(repository: string, headSha: string | null | undefined, files: PullFile[]): string[] {
  if (!/^[^/]+\/[^/]+$/.test(repository)) return [];
  const encodedRepository = repository.split("/").map(encodeURIComponent).join("/");
  return [...new Set(files.flatMap((file) => {
    if (/^removed$/i.test(file.status) || !committedMediaExtension.test(file.filename)) return [];
    let pinnedSha = /^[0-9a-f]{40,64}$/i.test(headSha ?? "") ? headSha! : undefined;
    if (!pinnedSha && file.raw_url) {
      try {
        const raw = new URL(file.raw_url);
        const match = raw.hostname === "github.com" ? raw.pathname.match(/^\/([^/]+)\/([^/]+)\/raw\/([0-9a-f]{40,64})\//i) : null;
        if (match && `${decodeURIComponent(match[1])}/${decodeURIComponent(match[2])}`.toLowerCase() === repository.toLowerCase()) pinnedSha = match[3];
      } catch {
        // Ignore malformed fallback URLs returned by incomplete cache data.
      }
    }
    if (!pinnedSha) return [];
    const encodedPath = file.filename.split("/").map(encodeURIComponent).join("/");
    return [`https://raw.githubusercontent.com/${encodedRepository}/${pinnedSha}/${encodedPath}`];
  }))];
}

export function mergeMediaUrls(...groups: string[][]): string[] {
  return [...new Set(groups.flat())];
}

export function firstImage(body: string | null): string | undefined {
  return extractMediaUrls(body)[0];
}

export function reviewCredits(reviews: PullReview[]): { reviewers: string[]; approvers: string[] } {
  const humans = reviews.filter((review) => {
    const login = review.user?.login ?? "";
    return login.length > 0 && !isBotLogin(login) && !/^(?:PENDING|DISMISSED)$/i.test(review.state);
  });
  const unique = (values: string[]) => [...new Map(values.map((login) => [login.toLowerCase(), login])).values()].sort((a, b) => a.localeCompare(b));
  return {
    reviewers: unique(humans.map((review) => review.user!.login)),
    approvers: unique(humans.filter((review) => /^APPROVED$/i.test(review.state)).map((review) => review.user!.login)),
  };
}

async function fetchPullRequestReviews(client: GitHubClient, pullRequestUrl: string): Promise<PullReview[]> {
  const reviews: PullReview[] = [];
  for (let page = 1; ; page += 1) {
    const separator = pullRequestUrl.includes("?") ? "&" : "?";
    const batch = await client.get<PullReview[]>(`${pullRequestUrl}/reviews${separator}per_page=100&page=${page}`, { immutable: true });
    reviews.push(...batch);
    if (batch.length < 100) return reviews;
  }
}

async function fetchCommittedMediaUrls(client: GitHubClient, pullRequestUrl: string, detail: PullDetail): Promise<string[]> {
  if (!shouldInspectPullFiles(detail.title, detail.body) || detail.changed_files < 1) return [];
  const files: PullFile[] = [];
  const pages = Math.max(1, Math.ceil(detail.changed_files / 100));
  for (let page = 1; page <= pages; page += 1) {
    const batch = await client.get<PullFile[]>(`${pullRequestUrl}/files?per_page=100&page=${page}`, { immutable: true });
    files.push(...batch);
    if (batch.length < 100) break;
  }
  return committedMediaUrls(detail.base.repo.full_name, detail.head?.sha, files);
}

export function classify(title: string, labels: string[]): StoryKind {
  const haystack = `${title} ${labels.join(" ")}`.toLowerCase();
  if (/\b(doc|docs|documentation|translation|typo)\b/.test(haystack)) return "docs";
  if (/\b(fix|bug|repair|prevent|correct|crash)\b/.test(haystack)) return "fix";
  if (/\b(integration|device|support|feature|add|introduce|new)\b/.test(haystack)) return "feature";
  if (/\b(refactor|build|ci|test|chore|bump|dependency)\b/.test(haystack)) return "maintenance";
  return "platform";
}

export function unlockLine(title: string, kind: StoryKind): string | undefined {
  const clean = title.replace(/^(feat|fix|docs|refactor|chore)(\([^)]*\))?:\s*/i, "").replace(/[.!]$/, "");
  if (kind === "feature") return `Unlocks: ${clean.charAt(0).toUpperCase()}${clean.slice(1)}.`;
  if (kind === "fix") return `Improves reliability around ${clean.charAt(0).toLowerCase()}${clean.slice(1)}.`;
  return undefined;
}

function storyScore(detail: PullDetail, organization: OrganizationConfig, config: SourcesConfig, hasMedia = false): number {
  const labels = detail.labels.map((label) => label.name.toLowerCase());
  const title = detail.title.toLowerCase();
  const repo = detail.base.repo.full_name.split("/")[1];
  const featureLabels = normalizedSet(config.editorial.feature_labels);
  const breakingLabels = normalizedSet(config.editorial.breaking_labels);
  let score = 12 * organization.weight;
  if (organization.featured_repositories.map((item) => item.toLowerCase()).includes(repo.toLowerCase())) score += 8;
  if (labels.some((label) => featureLabels.has(label))) score += 14;
  if (labels.some((label) => breakingLabels.has(label))) score += 22;
  score += config.editorial.high_signal_terms.filter((term) => title.includes(term.toLowerCase())).length * 4;
  score += Math.min(detail.changed_files ?? 0, 20) * 0.7;
  score += Math.log10(Math.max((detail.additions ?? 0) + (detail.deletions ?? 0), 1)) * 3;
  score += Math.min((detail.comments ?? 0) + (detail.review_comments ?? 0), 20) * 0.5;
  if (firstImage(detail.body) || hasMedia) score += 4;
  if (classify(detail.title, labels) === "docs") score -= 8;
  if (classify(detail.title, labels) === "maintenance") score -= 10;
  return Math.round(score * 10) / 10;
}

export function isDependency(item: SearchItem, config: SourcesConfig): boolean {
  const author = item.user?.login.toLowerCase() ?? "";
  return config.editorial.dependency_authors.map((name) => name.toLowerCase()).includes(author) || /\b(bump|deps?|dependencies|renovate)\b/i.test(item.title);
}

function makeDemoEdition(date: Date, editionDate: string, config: SourcesConfig): Edition {
  const stories: PullRequestStory[] = [
    {
      id: "demo-voice", title: "A clearer path for local voice commands", summary: "A representative feature story showing how a merged change can be translated into a concise, user-facing explanation.", unlocks: "Unlocks: Faster, more natural control without sending speech to the cloud.", url: "https://github.com/home-assistant/core/pulls", repository: "home-assistant/core", organization: "Home Assistant", author: "community-contributor", mergedAt: date.toISOString(), labels: ["feature"], kind: "feature", score: 48, changedFiles: 12,
    },
    {
      id: "demo-esphome", title: "ESPHome expands device support", summary: "This sample demonstrates how hardware and protocol work is promoted when it opens up a meaningful new capability.", unlocks: "Unlocks: One more class of local-first devices for makers and households.", url: "https://github.com/esphome/esphome/pulls", repository: "esphome/esphome", organization: "ESPHome", author: "device-builder", mergedAt: date.toISOString(), labels: ["new-feature"], kind: "feature", score: 43, changedFiles: 8,
    },
    {
      id: "demo-music", title: "Music Assistant playback becomes more resilient", summary: "Recovery behavior now handles interrupted players more gracefully, keeping multi-room sessions moving.", unlocks: "Improves reliability around interrupted network players.", url: "https://github.com/music-assistant/server/pulls", repository: "music-assistant/server", organization: "Music Assistant", author: "music-maker", mergedAt: date.toISOString(), labels: ["bug"], kind: "fix", score: 39, changedFiles: 5,
    },
    {
      id: "demo-zigpy", title: "New Zigbee device signatures land", summary: "Fresh device metadata broadens automatic recognition while keeping setup local and predictable.", url: "https://github.com/zigpy", repository: "zigpy/zigpy", organization: "Zigpy", author: "radio-friend", mergedAt: date.toISOString(), labels: ["device"], kind: "platform", score: 31, changedFiles: 3,
    },
    {
      id: "demo-accessibility", title: "Dashboard keyboard navigation gets a polish pass", summary: "Focus behavior and accessible names are tightened across a common dashboard interaction.", url: "https://github.com/home-assistant/frontend/pulls", repository: "home-assistant/frontend", organization: "Home Assistant", author: "frontend-friend", mergedAt: date.toISOString(), labels: ["accessibility"], kind: "fix", score: 29, changedFiles: 7,
    },
  ];
  return {
    date: editionDate,
    generatedAt: date.toISOString(),
    windowStart: new Date(date.getTime() - config.window_hours * 3_600_000).toISOString(),
    windowEnd: date.toISOString(),
    timezone: config.timezone,
    isDemo: true,
    stats: { mergedPullRequests: 14, repositories: 8, contributors: 12, dependencyUpdates: 4 },
    lead: stories[0],
    highlights: stories.slice(1, 4),
    briefs: stories.slice(4),
    dependencies: [
      { title: "Bump representative runtime dependency", url: "https://github.com/home-assistant/core/pulls", repository: "home-assistant/core", author: "dependabot[bot]" },
      { title: "Refresh frontend toolchain", url: "https://github.com/music-assistant/frontend/pulls", repository: "music-assistant/frontend", author: "renovate[bot]" },
      { title: "Update ESPHome build dependency", url: "https://github.com/esphome/esphome/pulls", repository: "esphome/esphome", author: "dependabot[bot]" },
      { title: "Refresh pre-commit hooks", url: "https://github.com/OpenHomeFoundation", repository: "OpenHomeFoundation/roadmap", author: "pre-commit-ci[bot]" },
    ],
    articles: [
      {
        id: "demo-local-voice",
        title: "Local voice control finds a clearer path",
        dek: "A grouped demo article shows how the newsroom turns related merged work into one user-facing story.",
        body: ["The reporter connects implementation details into one narrative, while the source ledger keeps every claim traceable to the merged work.", "Reviewer and approver credit comes from GitHub review records and is added after the AI plan, so the names are factual rather than generated."],
        kind: "daily",
        placement: "lead",
        score: 92,
        contributors: ["community-contributor"],
        reviewers: ["thoughtful-reviewer"],
        approvers: ["thoughtful-reviewer"],
        topics: ["Voice", "Local control"],
        continuity: "The history query can connect today’s discovery work to sensors or services that merged earlier.",
        pullRequests: [{ id: "demo-voice", title: stories[0].title, url: stories[0].url, repository: stories[0].repository }],
        media: [],
      },
      {
        id: "demo-device-support",
        title: "ESPHome opens the door to another device family",
        dek: "Hardware support and its companion documentation are treated as one product story, not duplicate headlines.",
        body: ["Companion docs support the feature article. Independent guide improvements would still remain eligible for their own coverage."],
        kind: "daily",
        placement: "feature",
        score: 79,
        contributors: ["device-builder"],
        reviewers: ["firmware-reviewer"],
        approvers: ["firmware-reviewer"],
        topics: ["ESPHome", "Devices"],
        pullRequests: [{ id: "demo-esphome", title: stories[1].title, url: stories[1].url, repository: stories[1].repository }],
        media: [],
      },
      {
        id: "demo-weekly-recap",
        title: "The week moved local playback and device recognition forward",
        dek: "Monday’s recap selects connected themes from the preceding seven days instead of replaying every merge.",
        body: ["Music playback reliability and broader Zigbee recognition were among the week’s representative themes in this seeded preview."],
        kind: "weekly_recap",
        placement: "feature",
        score: 74,
        contributors: ["music-maker", "radio-friend"],
        reviewers: ["weekly-reviewer"],
        approvers: [],
        topics: ["Week in review"],
        pullRequests: [
          { id: "demo-music", title: stories[2].title, url: stories[2].url, repository: stories[2].repository },
          { id: "demo-zigpy", title: stories[3].title, url: stories[3].url, repository: stories[3].repository },
        ],
        media: [],
      },
    ],
    pulse: [
      { product: "Home Assistant", today: 8, thisWeek: 53, sinceRelease: 117, lastReleaseDate: "2026-08-05" },
      { product: "Music Assistant", today: 3, thisWeek: 19, sinceRelease: 28, lastReleaseDate: "2026-08-18" },
      { product: "ESPHome", today: 3, thisWeek: 31, sinceRelease: 42, lastReleaseDate: "2026-08-19" },
    ],
    landedReleases: [],
    releases: buildReleaseCalendar(editionDate, config.release_cycles, 4, config.release_horizon_days ?? 45),
    notes: ["This is a seeded preview edition. Run npm run collect with a GitHub token to replace it with live reporting."],
  };
}

function normalizedSet(values: string[]): Set<string> {
  return new Set(values.map((value) => value.toLowerCase()));
}

async function searchMergedPullRequests(
  client: GitHubClient,
  organization: OrganizationConfig,
  start: Date,
  end: Date,
  maximum: number,
): Promise<{ items: SearchItem[]; total: number; incomplete: boolean }> {
  if (!Number.isFinite(maximum) || maximum < 1) throw new TypeError("max_prs_per_organization must be a positive number.");
  const limit = Math.floor(maximum);
  const query = `org:${organization.slug} is:public is:pr is:merged merged:${start.toISOString()}..${end.toISOString()}`;
  const items: SearchItem[] = [];
  let total = 0;
  let incomplete = false;

  for (let page = 1; items.length < limit; page += 1) {
    const pageSize = Math.min(100, limit - items.length);
    const searchUrl = `https://api.github.com/search/issues?q=${encodeURIComponent(query)}&sort=updated&order=desc&per_page=${pageSize}&page=${page}`;
    const response = await client.get<SearchResponse>(searchUrl, { maxAgeMinutes: 15 });
    if (!Number.isSafeInteger(response.total_count) || response.total_count < 0) {
      throw new Error(`GitHub returned an invalid merged pull request total for ${organization.slug}.`);
    }
    total = response.total_count;
    incomplete ||= response.incomplete_results;
    items.push(...response.items);
    if (response.items.length < pageSize || items.length >= response.total_count) break;
  }

  return { items: items.slice(0, limit), total, incomplete };
}

async function mapWithConcurrency<T, U>(values: T[], concurrency: number, mapper: (value: T) => Promise<U>): Promise<U[]> {
  const output = new Array<U>(values.length);
  let nextIndex = 0;
  async function worker(): Promise<void> {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      output[index] = await mapper(values[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, () => worker()));
  return output;
}

function normalizedReleaseName(value: string): string {
  return value.trim().toLowerCase().replace(/^release\s+/, "").replace(/^v(?=\d)/, "");
}

export function landedReleasesFromHistory(
  source: ReleaseSourceConfig,
  history: GitHubRelease[],
  start: Date,
  end: Date,
  stories: PullRequestStory[] = [],
): LandedRelease[] {
  return history.flatMap((release) => {
    const publishedAt = release.published_at ? Date.parse(release.published_at) : Number.NaN;
    if (release.draft || !Number.isFinite(publishedAt) || publishedAt < start.getTime() || publishedAt > end.getTime()) return [];
    if (release.prerelease && !source.include_prereleases) return [];
    const names = new Set([release.tag_name, release.name ?? ""].map(normalizedReleaseName).filter(Boolean));
    const sourcePullRequestIds = stories.filter((story) => {
      if (story.repository.toLowerCase() !== source.repository.toLowerCase()) return false;
      const exactName = names.has(normalizedReleaseName(story.title));
      const releaseLabelNearPublication = story.labels.includes("merging-to-release")
        && Math.abs(Date.parse(story.mergedAt) - publishedAt) <= 6 * 3_600_000;
      return exactName || releaseLabelNearPublication;
    }).map((story) => story.id);
    return [{
      id: `${source.repository.toLowerCase()}:${release.id ?? release.tag_name}`,
      product: source.product,
      repository: source.repository,
      name: release.name?.trim() || release.tag_name,
      tag: release.tag_name,
      url: release.html_url,
      publishedAt: release.published_at!,
      channel: release.prerelease ? "prerelease" as const : "stable" as const,
      accent: source.accent,
      sourcePullRequestIds: sourcePullRequestIds.length > 0 ? sourcePullRequestIds : undefined,
    }];
  }).sort((left, right) => right.publishedAt.localeCompare(left.publishedAt));
}

async function fetchReleaseHistory(client: GitHubClient, source: ReleaseSourceConfig, start: Date): Promise<GitHubRelease[]> {
  const history: GitHubRelease[] = [];
  for (let page = 1; page <= 10; page += 1) {
    const url = `https://api.github.com/repos/${source.repository}/releases?per_page=100&page=${page}`;
    const batch = await client.get<GitHubRelease[]>(url, { maxAgeMinutes: 30 });
    history.push(...batch);
    const dated = batch.flatMap((release) => release.published_at ? [Date.parse(release.published_at)] : []).filter(Number.isFinite);
    if (batch.length < 100 || (dated.length > 0 && Math.min(...dated) < start.getTime())) break;
  }
  return history;
}

async function enrichFirstContributions(
  client: GitHubClient,
  contributorCache: ContributorCache,
  inputs: Map<number, StoredPullRequestInput>,
): Promise<string[]> {
  const failures: string[] = [];
  for (const [id, input] of inputs) {
    if (input.author === "ghost" || isBotLogin(input.author)) continue;
    try {
      const { firstContribution, profile } = await lookupContributorDetails(client, contributorCachePath, contributorCache, input.repository, input.author);
      inputs.set(id, {
        ...input,
        authorProfile: profile,
        firstContribution,
        isFirstContribution: input.number === firstContribution.number,
      });
    } catch (error) {
      failures.push(`${input.repository} / ${input.author}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return failures;
}

async function storeHistoryWindow(
  config: SourcesConfig,
  client: GitHubClient,
  contributorCache: ContributorCache,
  start: Date,
  end: Date,
): Promise<{ written: number; failures: string[] }> {
  const failures: string[] = [];
  const inputs = new Map<number, StoredPullRequestInput>();
  for (const organization of config.organizations.filter((item) => item.enabled)) {
    console.log(`Backfilling ${organization.name} from ${start.toISOString()} to ${end.toISOString()}…`);
    let search: Awaited<ReturnType<typeof searchMergedPullRequests>>;
    try {
      search = await searchMergedPullRequests(client, organization, start, end, 1_000);
    } catch (error) {
      failures.push(`${organization.name} search: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    if (search.incomplete || search.total > search.items.length) {
      failures.push(`${organization.name} search returned ${search.items.length} of ${search.total}${search.incomplete ? " and was marked incomplete" : ""}.`);
    }

    for (const item of search.items) {
      const repository = repositoryFromApiUrl(item.repository_url);
      inputs.set(item.id, {
        id: item.id,
        number: item.number,
        url: item.html_url,
        apiUrl: item.pull_request?.url,
        repository,
        organization: organization.name,
        title: item.title,
        body: item.body,
        author: item.user?.login ?? "ghost",
        mergedAt: item.pull_request?.merged_at ?? null,
        githubUpdatedAt: item.updated_at,
        labels: item.labels.map((label) => label.name.toLowerCase()),
        mediaUrls: extractMediaUrls(item.body),
        reviewers: [],
        approvers: [],
        stats: { comments: item.comments },
        isDependency: isDependency(item, config),
      });
    }

    await mapWithConcurrency(search.items.filter((item) => item.pull_request?.url), 6, async (item) => {
      const [detailResult, reviewsResult] = await Promise.allSettled([
        client.get<PullDetail>(item.pull_request!.url, { immutable: true }),
        fetchPullRequestReviews(client, item.pull_request!.url),
      ]);
      const credits = reviewsResult.status === "fulfilled" ? reviewCredits(reviewsResult.value) : { reviewers: [], approvers: [] };
      if (reviewsResult.status === "rejected") failures.push(`${item.html_url} reviews: ${reviewsResult.reason instanceof Error ? reviewsResult.reason.message : String(reviewsResult.reason)}`);
      if (detailResult.status === "rejected") {
        failures.push(`${item.html_url} details: ${detailResult.reason instanceof Error ? detailResult.reason.message : String(detailResult.reason)}`);
        const partial = inputs.get(item.id);
        if (partial) inputs.set(item.id, { ...partial, ...credits });
        return;
      }
      const detail = detailResult.value;
      let committedMedia: string[] = [];
      try {
        committedMedia = await fetchCommittedMediaUrls(client, item.pull_request!.url, detail);
      } catch (error) {
        console.warn(`Could not read committed media for ${item.html_url}: ${error instanceof Error ? error.message : String(error)}`);
      }
      inputs.delete(item.id);
      inputs.set(detail.id, {
        id: detail.id,
        number: detail.number,
        url: detail.html_url,
        apiUrl: item.pull_request!.url,
        repository: detail.base.repo.full_name,
        organization: organization.name,
        title: detail.title,
        body: detail.body,
        author: detail.user?.login ?? "ghost",
        mergedAt: detail.merged_at,
        githubUpdatedAt: detail.updated_at,
        labels: detail.labels.map((label) => label.name.toLowerCase()),
        mediaUrls: mergeMediaUrls(extractMediaUrls(detail.body), committedMedia),
        reviewers: credits.reviewers,
        approvers: credits.approvers,
        stats: {
          additions: detail.additions,
          deletions: detail.deletions,
          changedFiles: detail.changed_files,
          comments: detail.comments,
          reviewComments: detail.review_comments,
        },
        isDependency: isDependency(item, config),
      });
    });
  }
  failures.push(...await enrichFirstContributions(client, contributorCache, inputs));
  const result = await upsertPullRequestStore(pullRequestDirectory, [...inputs.values()]);
  return { written: result.written, failures };
}

export interface CollectRangeOptions {
  from: string;
  to: string;
}

export function backfillDatesNewestFirst(from: string, to: string, timeZone: string): string[] {
  const first = startOfEditionDate(from, timeZone);
  const last = startOfEditionDate(to, timeZone);
  if (first > last) throw new TypeError("Backfill --from must be on or before --to.");

  const cursor = new Date(`${to}T12:00:00Z`);
  const finalDate = new Date(`${from}T12:00:00Z`);
  const dates: string[] = [];
  while (cursor >= finalDate) {
    dates.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() - 1);
  }
  return dates;
}

export async function collectRange(options: CollectRangeOptions): Promise<{ written: number; days: number }> {
  const config = await loadYaml<SourcesConfig>(configPath);
  const dates = backfillDatesNewestFirst(options.from, options.to, config.timezone);
  const cache = await loadCache();
  const client = new GitHubClient(cache);
  const contributorCache = await loadContributorCache(contributorCachePath);
  let written = 0;
  let days = 0;
  for (const date of dates) {
    const result = await storeHistoryWindow(config, client, contributorCache, startOfEditionDate(date, config.timezone), endOfEditionDate(date, config.timezone));
    written += result.written;
    days += 1;
    await saveJsonAtomic(cachePath, cache);
    if (result.failures.length > 0) {
      throw new Error(`Backfill stopped after persisting available data for ${date}:\n${result.failures.join("\n")}`);
    }
  }
  return { written, days };
}

export function latestScheduledReleaseDate(asOfDate: string, cycle: ReleaseCycle): string {
  const asOf = new Date(`${asOfDate}T12:00:00Z`);
  if (Number.isNaN(asOf.getTime()) || asOf.toISOString().slice(0, 10) !== asOfDate) throw new TypeError("Pulse date must be a valid YYYY-MM-DD date.");
  for (let monthOffset = 0; monthOffset > -3; monthOffset -= 1) {
    const month = new Date(Date.UTC(asOf.getUTCFullYear(), asOf.getUTCMonth() + monthOffset, 1, 12));
    const weekdayOffset = (3 - month.getUTCDay() + 7) % 7;
    month.setUTCDate(month.getUTCDate() + weekdayOffset + cycle.release_offset_days);
    const candidate = month.toISOString().slice(0, 10);
    if (candidate <= asOfDate) return candidate;
  }
  throw new Error(`Could not calculate the latest ${cycle.product} release.`);
}

export function buildProjectPulse(
  records: StoredPullRequest[],
  end: Date,
  editionDate: string,
  timeZone: string,
  cycles: ReleaseCycle[],
  musicAssistantRelease: GitHubRelease | null,
  authoritativeActivity?: ReadonlyMap<string, { today: number; thisWeek: number }>,
): ProjectPulseItem[] {
  const projects = [
    { product: "Home Assistant", prefix: "home-assistant/", cycle: cycles.find((cycle) => cycle.product === "Home Assistant"), release: null as GitHubRelease | null },
    { product: "Music Assistant", prefix: "music-assistant/", cycle: undefined, release: musicAssistantRelease },
    { product: "ESPHome", prefix: "esphome/", cycle: cycles.find((cycle) => cycle.product === "ESPHome"), release: null as GitHubRelease | null },
  ];
  const current24Hours = new Date(end.getTime() - 24 * 3_600_000).toISOString();
  const trailing7Days = new Date(end.getTime() - 7 * 24 * 3_600_000).toISOString();
  return projects.map((project) => {
    const projectRecords = records.filter((record) => record.repository.toLowerCase().startsWith(project.prefix));
    const scheduledDate = project.cycle ? latestScheduledReleaseDate(editionDate, project.cycle) : null;
    const lastReleaseDate = project.release?.published_at?.slice(0, 10) ?? scheduledDate;
    const releaseBoundary = project.release?.published_at ?? (scheduledDate ? startOfEditionDate(scheduledDate, timeZone).toISOString() : null);
    const countSince = (value: string) => queryPullRequests(projectRecords, { since: value, before: new Date(end.getTime() + 1).toISOString(), limit: Number.MAX_SAFE_INTEGER }).length;
    const activity = authoritativeActivity?.get(project.product);
    return {
      product: project.product,
      today: activity?.today ?? countSince(current24Hours),
      thisWeek: activity?.thisWeek ?? countSince(trailing7Days),
      sinceRelease: releaseBoundary ? countSince(releaseBoundary) : 0,
      lastReleaseDate,
    };
  });
}

type ProjectPulseTotalFetcher = (organization: OrganizationConfig, start: Date, end: Date) => Promise<number>;

export async function buildAuthoritativeProjectPulse(
  records: StoredPullRequest[],
  end: Date,
  editionDate: string,
  timeZone: string,
  cycles: ReleaseCycle[],
  musicAssistantRelease: GitHubRelease | null,
  organizations: OrganizationConfig[],
  authoritativeToday: ReadonlyMap<string, number>,
  fetchWeeklyTotal: ProjectPulseTotalFetcher,
): Promise<ProjectPulseItem[]> {
  const scopes = [
    { product: "Home Assistant", slug: "home-assistant" },
    { product: "Music Assistant", slug: "music-assistant" },
    { product: "ESPHome", slug: "esphome" },
  ];
  const trailing7Days = new Date(end.getTime() - 7 * 24 * 3_600_000);
  const activity = new Map<string, { today: number; thisWeek: number }>();

  for (const scope of scopes) {
    const organization = organizations.find((item) => item.enabled && item.slug.toLowerCase() === scope.slug);
    if (!organization) throw new Error(`Project Pulse requires the enabled ${scope.slug} organization scope.`);
    const today = authoritativeToday.get(scope.slug);
    if (today === undefined || !Number.isSafeInteger(today) || today < 0) {
      throw new Error(`Project Pulse is missing an authoritative daily total for ${scope.slug}.`);
    }
    const thisWeek = await fetchWeeklyTotal(organization, trailing7Days, end);
    if (!Number.isSafeInteger(thisWeek) || thisWeek < 0) {
      throw new Error(`Project Pulse received an invalid seven-day total for ${scope.slug}.`);
    }
    activity.set(scope.product, { today, thisWeek });
  }

  return buildProjectPulse(records, end, editionDate, timeZone, cycles, musicAssistantRelease, activity);
}

export interface CollectionResult {
  edition: Edition;
  projectPulse: ProjectPulseItem[];
}

export function releaseTargetsForDate(date: string, releases: Edition["releases"]): ActiveReleaseTarget[] {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new TypeError("Release target date must use YYYY-MM-DD format.");
  return releases
    .filter((event) => event.kind === "Release" && event.date === date)
    .map((event) => {
      const [year, month] = event.date.split("-").map(Number);
      return { product: event.product, version: `${year}.${month}`, releaseDate: event.date };
    });
}

export function releasePreviewTargetsForDate(
  date: string,
  releases: Edition["releases"],
  cycles: ReleaseCycle[],
): ActiveReleaseTarget[] {
  const betaDays = new Map(cycles.map((cycle) => [cycle.product, cycle.beta_days_before]));
  return releases.flatMap((event) => {
    if (event.kind !== "Release") return [];
    const daysBefore = betaDays.get(event.product);
    if (daysBefore === undefined) return [];
    const betaStart = new Date(`${event.date}T00:00:00Z`);
    betaStart.setUTCDate(betaStart.getUTCDate() - daysBefore);
    if (date < betaStart.toISOString().slice(0, 10) || date > event.date) return [];
    const [year, month] = event.date.split("-").map(Number);
    return [{ product: event.product, version: `${year}.${month}`, releaseDate: event.date }];
  });
}

async function storedReleasePreviews(date: string): Promise<ReleasePreview[]> {
  try {
    const edition = JSON.parse(await readFile(resolve(editionDirectory, `${date}.json`), "utf8")) as Edition;
    return edition.releasePreviews ?? [];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

export async function collect(): Promise<CollectionResult> {
  const config = await loadYaml<SourcesConfig>(configPath);
  const requestedDate = getArgument("--date");
  const { editionDate, start, end } = reportingWindow(new Date(), requestedDate, config.timezone, config.window_hours);
  const releaseCalendar = buildReleaseCalendar(editionDate, config.release_cycles, 4, config.release_horizon_days ?? 45);

  if (hasArgument("--demo")) {
    const demo = makeDemoEdition(end, editionDate, config);
    await saveJsonAtomic(resolve(editionDirectory, `${demo.date}.json`), demo);
    console.log(`Wrote demo edition ${demo.date}.`);
    return { edition: demo, projectPulse: demo.pulse ?? [] };
  }

  const contentFeedCollection = collectContentFeeds({
    root,
    sources: config.feed_sources ?? [],
    start,
    end,
  }).catch((error) => ({
    current: [],
    written: 0,
    unchanged: 0,
    configured: 0,
    warnings: [`Official posts and external coverage could not be collected: ${error instanceof Error ? error.message : String(error)}`],
  }));
  const releaseTargets = releaseTargetsForDate(editionDate, releaseCalendar);
  const previewTargets = releasePreviewTargetsForDate(editionDate, releaseCalendar, config.release_cycles);
  const previousReleasePreviews = releaseTargets.length > 0 ? await storedReleasePreviews(editionDate) : [];
  const historicalEdition = editionDate < dateInTimeZone(new Date(), config.timezone);
  const reusableHistoricalPreviews = historicalEdition && releaseTargets.every((target) => previousReleasePreviews.some((preview) =>
    preview.product === target.product && preview.version === target.version && preview.releaseDate.slice(0, 10) === target.releaseDate,
  ));
  if (historicalEdition && releaseTargets.length > 0 && !reusableHistoricalPreviews) {
    throw new Error(`Historical release-day edition ${editionDate} has no stored official preview snapshot; refusing to overwrite it with current preview data.`);
  }
  const releasePreviewCollection = reusableHistoricalPreviews
    ? Promise.resolve({ previews: previousReleasePreviews, warnings: [] })
    : !historicalEdition && previewTargets.length > 0
    ? collectReleasePreviews({
      root,
      sources: config.release_preview_sources ?? [],
      targets: previewTargets,
    }).catch((error) => ({
      previews: [],
      warnings: [`Release previews could not be collected: ${error instanceof Error ? error.message : String(error)}`],
    }))
    : Promise.resolve({ previews: [], warnings: [] });

  const cache = await loadCache();
  const client = new GitHubClient(cache);
  const contributorCache = await loadContributorCache(contributorCachePath);
  const stories: PullRequestStory[] = [];
  const dependencies: DependencyItem[] = [];
  const notes: string[] = [];
  const ignoredLabels = normalizedSet(config.editorial.ignore_labels);
  const seenPullRequests = new Set<number>();
  const seenDependencies = new Set<string>();
  let mergedPullRequestCount = 0;
  let detailFailures = 0;
  let mediaFailures = 0;
  let reviewFailures = 0;
  let contributorLookupFailures = 0;
  let storedPullRequestWrites = 0;
  const authoritativeDailyTotals = new Map<string, number>();

  for (const organization of config.organizations.filter((item) => item.enabled)) {
    console.log(`Scanning ${organization.name}…`);
    let search: Awaited<ReturnType<typeof searchMergedPullRequests>>;
    try {
      search = await searchMergedPullRequests(client, organization, start, end, config.max_prs_per_organization);
    } catch (error) {
      console.warn(`Could not scan ${organization.name}: ${error instanceof Error ? error.message : String(error)}`);
      notes.push(`${organization.name} could not be scanned for this edition.`);
      continue;
    }
    mergedPullRequestCount += search.total;
    if (search.incomplete) notes.push(`GitHub marked the ${organization.name} search results as incomplete.`);
    if (!search.incomplete) authoritativeDailyTotals.set(organization.slug.toLowerCase(), search.total);
    if (search.total > search.items.length) {
      notes.push(`${organization.name} had ${search.total} merged pull requests; the configured limit included ${search.items.length}.`);
    }

    const detailItems: SearchItem[] = [];
    const storeInputs = new Map<number, StoredPullRequestInput>();
    for (const item of search.items) {
      const labels = item.labels.map((label) => label.name.toLowerCase());
      const repository = repositoryFromApiUrl(item.repository_url);
      const dependency = isDependency(item, config);
      storeInputs.set(item.id, {
        id: item.id,
        number: item.number,
        url: item.html_url,
        apiUrl: item.pull_request?.url,
        repository,
        organization: organization.name,
        title: item.title,
        body: item.body,
        author: item.user?.login ?? "ghost",
        mergedAt: item.pull_request?.merged_at ?? null,
        githubUpdatedAt: item.updated_at,
        labels,
        mediaUrls: extractMediaUrls(item.body),
        reviewers: [],
        approvers: [],
        stats: { comments: item.comments },
        isDependency: dependency,
      });
      if (!labels.some((label) => ignoredLabels.has(label)) && dependency) {
        if (!seenDependencies.has(item.html_url)) {
          seenDependencies.add(item.html_url);
          dependencies.push({ title: item.title, url: item.html_url, repository, author: item.user?.login ?? "ghost" });
        }
      }
      if (item.pull_request?.url) detailItems.push(item);
    }

    const results = await mapWithConcurrency(detailItems, 6, async (item): Promise<PullRequestStory | null> => {
      const [detailResult, reviewsResult] = await Promise.allSettled([
        client.get<PullDetail>(item.pull_request!.url, { immutable: true }),
        fetchPullRequestReviews(client, item.pull_request!.url),
      ]);
      const credits = reviewsResult.status === "fulfilled" ? reviewCredits(reviewsResult.value) : { reviewers: [], approvers: [] };
      if (reviewsResult.status === "rejected") {
        reviewFailures += 1;
        console.warn(`Could not read reviews for ${item.html_url}: ${reviewsResult.reason instanceof Error ? reviewsResult.reason.message : String(reviewsResult.reason)}`);
      }
      if (detailResult.status === "rejected") {
        detailFailures += 1;
        const partial = storeInputs.get(item.id);
        if (partial) storeInputs.set(item.id, { ...partial, ...credits });
        console.warn(`Could not read ${item.html_url}: ${detailResult.reason instanceof Error ? detailResult.reason.message : String(detailResult.reason)}`);
        return null;
      }
      try {
        const detail = detailResult.value;
        const labels = detail.labels.map((label) => label.name.toLowerCase());
        let committedMedia: string[] = [];
        try {
          committedMedia = await fetchCommittedMediaUrls(client, item.pull_request!.url, detail);
        } catch (error) {
          mediaFailures += 1;
          console.warn(`Could not read committed media for ${item.html_url}: ${error instanceof Error ? error.message : String(error)}`);
        }
        const mediaUrls = mergeMediaUrls(extractMediaUrls(detail.body), committedMedia);
        storeInputs.delete(item.id);
        storeInputs.set(detail.id, {
          id: detail.id,
          number: detail.number,
          url: detail.html_url,
          apiUrl: item.pull_request!.url,
          repository: detail.base.repo.full_name,
          organization: organization.name,
          title: detail.title,
          body: detail.body,
          author: detail.user?.login ?? "ghost",
          mergedAt: detail.merged_at,
          githubUpdatedAt: detail.updated_at,
          labels,
          mediaUrls,
          reviewers: credits.reviewers,
          approvers: credits.approvers,
          stats: {
            additions: detail.additions,
            deletions: detail.deletions,
            changedFiles: detail.changed_files,
            comments: detail.comments,
            reviewComments: detail.review_comments,
          },
          isDependency: isDependency(item, config),
        });
        if (!detail.merged_at || seenPullRequests.has(detail.id) || isDependency(item, config)) return null;
        const mergedAt = new Date(detail.merged_at).getTime();
        if (!Number.isFinite(mergedAt) || mergedAt < start.getTime() || mergedAt > end.getTime()) return null;
        seenPullRequests.add(detail.id);
        if (labels.some((label) => ignoredLabels.has(label))) return null;
        const kind = classify(detail.title, labels);
        return {
          id: String(detail.id),
          title: detail.title,
          summary: sentenceSummary(detail.body, detail.title),
          unlocks: unlockLine(detail.title, kind),
          url: detail.html_url,
          repository: detail.base.repo.full_name,
          organization: organization.name,
          author: detail.user?.login ?? "ghost",
          mergedAt: detail.merged_at,
          labels,
          kind,
          score: storyScore(detail, organization, config, mediaUrls.length > 0),
          additions: detail.additions,
          deletions: detail.deletions,
          changedFiles: detail.changed_files,
          image: mediaUrls.find((url) => /\.(?:avif|gif|jpe?g|png|webp)(?:[?#]|$)/i.test(url)),
        };
      } catch (error) {
        detailFailures += 1;
        console.warn(`Could not read ${item.html_url}: ${error instanceof Error ? error.message : String(error)}`);
        return null;
      }
    });
    const contributionFailures = await enrichFirstContributions(client, contributorCache, storeInputs);
    contributorLookupFailures += contributionFailures.length;
    for (const failure of contributionFailures) console.warn(`Could not establish first contribution for ${failure}`);
    const storeResult = await upsertPullRequestStore(pullRequestDirectory, [...storeInputs.values()]);
    storedPullRequestWrites += storeResult.written;
    stories.push(...results.filter((story): story is PullRequestStory => story !== null));
  }

  if (detailFailures > 0) notes.push(`${detailFailures} pull request detail${detailFailures === 1 ? "" : "s"} could not be loaded.`);
  if (mediaFailures > 0) notes.push(`${mediaFailures} signaled pull request media list${mediaFailures === 1 ? "" : "s"} could not be loaded.`);
  if (reviewFailures > 0) notes.push(`${reviewFailures} pull request review list${reviewFailures === 1 ? "" : "s"} could not be loaded.`);
  if (contributorLookupFailures > 0) notes.push(`${contributorLookupFailures} first-time contributor lookup${contributorLookupFailures === 1 ? "" : "s"} could not be completed.`);

  const contentFeeds = await contentFeedCollection;
  notes.push(...contentFeeds.warnings);
  console.log(`Content feeds: ${contentFeeds.current.length} current, ${contentFeeds.written} archived, ${contentFeeds.configured} configured.`);

  const releasePreviews = await releasePreviewCollection;
  notes.push(...releasePreviews.warnings);
  if (previewTargets.length > 0) {
    console.log(`Release previews: ${releasePreviews.previews.length} of ${previewTargets.length} active source${previewTargets.length === 1 ? "" : "s"} cached.`);
  }
  const editionReleasePreviews = releasePreviews.previews.filter((preview) => releaseTargets.some((target) =>
    target.product === preview.product && target.version === preview.version && target.releaseDate === preview.releaseDate.slice(0, 10),
  ));

  const releaseHistories = new Map<string, GitHubRelease[]>();
  const landedReleases: LandedRelease[] = [];
  const releaseSources = config.release_sources ?? [];
  const releaseResults = await mapWithConcurrency(releaseSources, 4, async (source) => {
    try {
      const history = await fetchReleaseHistory(client, source, start);
      return { source, history, error: null as string | null };
    } catch (error) {
      return { source, history: [] as GitHubRelease[], error: error instanceof Error ? error.message : String(error) };
    }
  });
  for (const result of releaseResults) {
    releaseHistories.set(result.source.repository.toLowerCase(), result.history);
    if (result.error) {
      console.warn(`Could not load releases for ${result.source.repository}: ${result.error}`);
      notes.push(`${result.source.product} releases could not be refreshed for Release Radar.`);
      continue;
    }
    landedReleases.push(...landedReleasesFromHistory(result.source, result.history, start, end, stories));
  }
  landedReleases.sort((left, right) => right.publishedAt.localeCompare(left.publishedAt));

  const musicAssistantRelease = (releaseHistories.get("music-assistant/server") ?? [])
    .filter((release): release is GitHubRelease & { published_at: string } => Boolean(release.published_at) && !release.draft && !release.prerelease && Date.parse(release.published_at!) <= end.getTime())
    .sort((left, right) => right.published_at.localeCompare(left.published_at))[0] ?? null;
  if (!musicAssistantRelease) notes.push("No Music Assistant release baseline was available on or before this edition.");
  const pulse = await buildAuthoritativeProjectPulse(
    await readPullRequestStore(pullRequestDirectory),
    end,
    editionDate,
    config.timezone,
    config.release_cycles,
    musicAssistantRelease,
    config.organizations,
    authoritativeDailyTotals,
    async (organization, pulseStart, pulseEnd) => {
      const result = await searchMergedPullRequests(client, organization, pulseStart, pulseEnd, 1);
      if (result.incomplete) throw new Error(`GitHub returned an incomplete seven-day Project Pulse count for ${organization.slug}.`);
      return result.total;
    },
  );

  const ranked = stories.sort((a, b) => b.score - a.score || b.mergedAt.localeCompare(a.mergedAt));
  const lead = ranked[0] ?? null;
  const highlights = ranked.slice(1, config.front_page_stories);
  const briefs = ranked.slice(config.front_page_stories, config.front_page_stories + config.briefs_limit);
  const allItems = [...stories, ...dependencies];
  const editionNotes = [...notes, ...(ranked.length === 0 ? ["No editorial stories were found in this reporting window."] : [])];
  const edition: Edition = {
    date: editionDate,
    generatedAt: new Date().toISOString(),
    windowStart: start.toISOString(),
    windowEnd: end.toISOString(),
    timezone: config.timezone,
    stats: {
      mergedPullRequests: mergedPullRequestCount,
      repositories: new Set(allItems.map((item) => item.repository)).size,
      contributors: new Set(allItems.map((item) => item.author)).size,
      dependencyUpdates: dependencies.length,
    },
    lead,
    highlights,
    briefs,
    dependencies,
    pulse,
    landedReleases,
    releasePreviews: editionReleasePreviews.length > 0 ? editionReleasePreviews : undefined,
    releases: releaseCalendar,
    notes: editionNotes.length > 0 ? editionNotes : undefined,
  };

  await Promise.all([
    saveJsonAtomic(resolve(editionDirectory, `${edition.date}.json`), edition),
    saveJsonAtomic(cachePath, cache),
  ]);
  console.log(`Wrote ${edition.date}: ${stories.length} stories, ${dependencies.length} dependency updates, ${storedPullRequestWrites} PR history revisions, and ${contentFeeds.written} content revisions.`);
  return { edition, projectPulse: pulse };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  collect().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
