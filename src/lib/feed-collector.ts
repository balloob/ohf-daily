import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parseFeed } from "./feed-parser";
import { queryContent, readContentStore, upsertContentStore, type StoredContent, type StoredContentInput } from "./content-store";

export interface FeedSourceConfig {
  id: string;
  name: string;
  kind: "official" | "google_alert";
  desk?: string;
  url?: string;
  url_env?: string;
  enabled?: boolean;
}

interface FeedCacheEntry {
  fetchedAt: string;
  sourceFingerprint?: string;
  etag?: string;
  lastModified?: string;
  body: string;
}

interface FeedCache {
  version: 1;
  entries: Record<string, FeedCacheEntry>;
}

export interface FeedCollectionResult {
  current: StoredContent[];
  written: number;
  unchanged: number;
  warnings: string[];
  configured: number;
}

export interface FeedCollectionOptions {
  root: string;
  sources: FeedSourceConfig[];
  start: Date;
  end: Date;
  fetcher?: typeof fetch;
  environment?: NodeJS.ProcessEnv;
  now?: () => Date;
}

const maximumFeedBytes = 2 * 1024 * 1024;

function safeFeedUrl(value: string, kind: FeedSourceConfig["kind"]): URL {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password) throw new TypeError("Feed URLs must use credential-free HTTPS.");
  if (kind === "google_alert" && !(["google.com", "www.google.com"].includes(url.hostname.toLowerCase()) && url.pathname.startsWith("/alerts/feeds/"))) {
    throw new TypeError("Google Alert feeds must use an official google.com /alerts/feeds/ URL.");
  }
  return url;
}

function normalizedSource(source: FeedSourceConfig, environment: NodeJS.ProcessEnv): FeedSourceConfig & { url: string } {
  const id = source.id.trim();
  const name = source.name.trim();
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id) || !name) throw new TypeError("Feed sources need a lowercase kebab-case id and display name.");
  if (source.kind !== "official" && source.kind !== "google_alert") throw new TypeError(`Feed source ${id} has an unsupported kind.`);
  if (Boolean(source.url) === Boolean(source.url_env)) throw new TypeError(`Feed source ${id} must set exactly one of url or url_env.`);
  const value = source.url ?? environment[source.url_env!];
  if (!value) throw new Error(`Feed source ${id} requires the ${source.url_env} environment variable.`);
  return { ...source, id, name, url: safeFeedUrl(value.trim(), source.kind).toString() };
}

export function googleAlertSources(value: string | undefined, warnings?: string[]): FeedSourceConfig[] {
  if (!value?.trim()) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new TypeError("GOOGLE_ALERT_FEEDS_JSON must be valid JSON.");
  }
  if (!Array.isArray(parsed)) throw new TypeError("GOOGLE_ALERT_FEEDS_JSON must be an array.");
  return parsed.flatMap((item, index) => {
    let message: string | undefined;
    if (!item || typeof item !== "object") message = `Google Alert feed ${index + 1} must be an object.`;
    else {
      const entry = item as Record<string, unknown>;
      if (typeof entry.id === "string" && typeof entry.name === "string" && typeof entry.url === "string") {
        return [{ id: entry.id, name: entry.name, url: entry.url, kind: "google_alert" as const, desk: "External coverage" }];
      }
      message = `Google Alert feed ${index + 1} requires id, name, and url strings.`;
    }
    if (!warnings) throw new TypeError(message);
    warnings.push(message);
    return [];
  });
}

function stableContentId(sourceId: string, guid: string, url: string): string {
  const digest = createHash("sha256").update(`${sourceId}\0${guid || url}`).digest("hex").slice(0, 24);
  return `${sourceId}:${digest}`;
}

function sourceFingerprint(source: FeedSourceConfig & { url: string }): string {
  return createHash("sha256").update(`${source.kind}\0${source.url}`).digest("hex");
}

function googleAlertTarget(value: string): string {
  const parsed = new URL(value);
  if (["google.com", "www.google.com"].includes(parsed.hostname.toLowerCase()) && parsed.pathname === "/url") {
    const target = parsed.searchParams.get("url") ?? parsed.searchParams.get("q");
    if (target) return safeFeedUrl(target, "official").toString();
  }
  return safeFeedUrl(value, "official").toString();
}

async function readCache(path: string): Promise<FeedCache> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as Partial<FeedCache>;
    if (parsed.version === 1 && parsed.entries && typeof parsed.entries === "object") return parsed as FeedCache;
  } catch {
    // A missing or malformed feed cache only costs another conditional request.
  }
  return { version: 1, entries: {} };
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`);
  await rename(temporary, path);
}

async function responseTextWithinLimit(response: Response): Promise<string> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maximumFeedBytes) throw new Error(`Feed response exceeds ${maximumFeedBytes} bytes.`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > maximumFeedBytes) throw new Error(`Feed response exceeds ${maximumFeedBytes} bytes.`);
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

async function fetchFeed(
  source: FeedSourceConfig & { url: string },
  cache: FeedCache,
  fetcher: typeof fetch,
  now: Date,
): Promise<{ body: string; warning?: string }> {
  const fingerprint = sourceFingerprint(source);
  const entry = cache.entries[source.id];
  const cached = entry?.sourceFingerprint === fingerprint ? entry : undefined;
  const headers: Record<string, string> = { Accept: "application/atom+xml, application/rss+xml, application/xml, text/xml;q=0.9" };
  if (cached?.etag) headers["If-None-Match"] = cached.etag;
  if (cached?.lastModified) headers["If-Modified-Since"] = cached.lastModified;
  try {
    const response = await fetcher(source.url, { headers, redirect: "follow", signal: AbortSignal.timeout(30_000) });
    safeFeedUrl(response.url || source.url, source.kind);
    if (response.status === 304 && cached) {
      cached.fetchedAt = now.toISOString();
      return { body: cached.body };
    }
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
    if (contentType && !/(?:atom|rss|xml|text\/plain)/.test(contentType)) throw new Error(`unexpected content type ${contentType}`);
    const body = await responseTextWithinLimit(response);
    cache.entries[source.id] = {
      fetchedAt: now.toISOString(),
      sourceFingerprint: fingerprint,
      etag: response.headers.get("etag") ?? undefined,
      lastModified: response.headers.get("last-modified") ?? undefined,
      body,
    };
    return { body };
  } catch (error) {
    if (cached) return { body: cached.body, warning: `${source.name} could not be refreshed; cached feed data was used.` };
    throw error;
  }
}

export async function collectContentFeeds(options: FeedCollectionOptions): Promise<FeedCollectionResult> {
  if (Number.isNaN(options.start.getTime()) || Number.isNaN(options.end.getTime()) || options.start >= options.end) {
    throw new TypeError("Feed collection requires a valid start before end.");
  }
  const environment = options.environment ?? process.env;
  const warnings: string[] = [];
  let alertSources: FeedSourceConfig[] = [];
  try {
    alertSources = googleAlertSources(environment.GOOGLE_ALERT_FEEDS_JSON, warnings);
  } catch (error) {
    warnings.push(error instanceof Error ? error.message : String(error));
  }
  const configured = [...options.sources, ...alertSources].filter((source) => source.enabled !== false);
  const seenSourceIds = new Set<string>();
  const sources = configured.flatMap((source) => {
    try {
      const normalized = normalizedSource(source, environment);
      if (seenSourceIds.has(normalized.id)) {
        warnings.push(`Feed source id ${normalized.id} is duplicated; the later source was skipped.`);
        return [];
      }
      seenSourceIds.add(normalized.id);
      return [normalized];
    } catch (error) {
      warnings.push(error instanceof Error ? error.message : String(error));
      return [];
    }
  });
  const cachePath = resolve(options.root, "data/cache/feeds.json");
  const cache = await readCache(cachePath);
  const fetcher = options.fetcher ?? fetch;
  const observedAt = (options.now ?? (() => new Date()))();
  const batches = await Promise.all(sources.map(async (source): Promise<StoredContentInput[]> => {
    try {
      const fetched = await fetchFeed(source, cache, fetcher, observedAt);
      if (fetched.warning) warnings.push(fetched.warning);
      return parseFeed(fetched.body, { maxBytes: maximumFeedBytes }).map((entry) => {
        const url = source.kind === "google_alert" ? googleAlertTarget(entry.url) : entry.url;
        return {
          id: stableContentId(source.id, entry.guid, entry.url),
          kind: source.kind === "official" ? "official_post" : "external_coverage",
          source: source.kind === "official" ? source.name : new URL(url).hostname.replace(/^www\./, ""),
          title: entry.title,
          url,
          publishedAt: entry.publishedAt,
          updatedAt: entry.updatedAt,
          author: entry.author,
          body: entry.content || entry.summary || null,
          mediaUrls: entry.mediaUrls,
        };
      });
    } catch (error) {
      warnings.push(`${source.name} could not be collected: ${error instanceof Error ? error.message : String(error)}`);
      return [];
    }
  }));
  const inputs = batches.flat();
  const store = await upsertContentStore(resolve(options.root, "data/content"), inputs, observedAt);
  await writeJsonAtomic(cachePath, cache);
  const current = queryContent(await readContentStore(resolve(options.root, "data/content")), {
    since: options.start.toISOString(),
    before: options.end.toISOString(),
    limit: 10_000,
  });
  return { current, ...store, warnings, configured: sources.length };
}

export const feedCollectorInternals = { safeFeedUrl, stableContentId, sourceFingerprint, googleAlertTarget, normalizedSource, responseTextWithinLimit };
