import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { htmlToBoundedText, parseFeed, parseSitemap } from "./feed-parser";
import { queryContent, readContentStore, upsertContentStore, type StoredContent, type StoredContentInput } from "./content-store";

export interface FeedSourceConfig {
  id: string;
  name: string;
  kind: "official" | "google_alert";
  format?: "feed" | "sitemap";
  path_prefix?: string;
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
  const format = source.format ?? "feed";
  if (format !== "feed" && format !== "sitemap") throw new TypeError(`Feed source ${id} has an unsupported format.`);
  if (format === "sitemap" && source.kind !== "official") throw new TypeError(`Sitemap source ${id} must be official.`);
  const pathPrefix = source.path_prefix?.trim();
  if (format === "sitemap" && (!pathPrefix || !pathPrefix.startsWith("/"))) throw new TypeError(`Sitemap source ${id} requires an absolute path_prefix.`);
  if (format === "feed" && pathPrefix) throw new TypeError(`Feed source ${id} cannot set path_prefix.`);
  if (Boolean(source.url) === Boolean(source.url_env)) throw new TypeError(`Feed source ${id} must set exactly one of url or url_env.`);
  const value = source.url ?? environment[source.url_env!];
  if (!value) throw new Error(`Feed source ${id} requires the ${source.url_env} environment variable.`);
  return { ...source, id, name, format, path_prefix: pathPrefix, url: safeFeedUrl(value.trim(), source.kind).toString() };
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
  return createHash("sha256").update(`${source.kind}\0${source.format ?? "feed"}\0${source.path_prefix ?? ""}\0${source.url}`).digest("hex");
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

async function fetchDocument(
  source: FeedSourceConfig & { url: string },
  cache: FeedCache,
  fetcher: typeof fetch,
  now: Date,
  documentKind: "xml" | "html" = "xml",
): Promise<{ body: string; warning?: string }> {
  const fingerprint = sourceFingerprint(source);
  const entry = cache.entries[source.id];
  const cached = entry?.sourceFingerprint === fingerprint ? entry : undefined;
  const headers: Record<string, string> = {
    Accept: documentKind === "html"
      ? "text/html, application/xhtml+xml;q=0.9"
      : "application/atom+xml, application/rss+xml, application/xml, text/xml;q=0.9",
  };
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
    const accepted = documentKind === "html" ? /(?:html|text\/plain)/ : /(?:atom|rss|xml|text\/plain)/;
    if (contentType && !accepted.test(contentType)) throw new Error(`unexpected content type ${contentType}`);
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

function htmlAttribute(tag: string, name: string): string | undefined {
  const quoted = tag.match(new RegExp(`(?:^|\\s)${name}\\s*=\\s*(["'])([\\s\\S]*?)\\1`, "i"));
  if (quoted) return quoted[2];
  return tag.match(new RegExp(`(?:^|\\s)${name}\\s*=\\s*([^\\s>]+)`, "i"))?.[1];
}

function metadataValue(html: string, keys: string[]): string | undefined {
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    const key = (htmlAttribute(tag, "property") ?? htmlAttribute(tag, "name"))?.toLowerCase();
    if (key && keys.includes(key)) {
      const content = htmlAttribute(tag, "content");
      if (content) return content;
    }
  }
  return undefined;
}

function articleDateFromUrl(url: string, fallback: string): string {
  const match = new URL(url).pathname.match(/\/(\d{4}-\d{2}-\d{2})(?:-|\/)/);
  const value = match?.[1] ?? fallback.slice(0, 10);
  const timestamp = Date.parse(`${value}T00:00:00Z`);
  if (Number.isNaN(timestamp)) throw new Error(`Could not determine publication date for ${url}.`);
  return new Date(timestamp).toISOString();
}

function articleMetadata(html: string, url: string, lastModified: string): Omit<StoredContentInput, "id" | "kind" | "source"> {
  const titleHtml = metadataValue(html, ["og:title", "twitter:title"])
    ?? html.match(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/i)?.[1]
    ?? new URL(url).pathname.split("/").filter(Boolean).at(-1)?.replace(/[-_]+/g, " ")
    ?? "Nabu Casa news";
  const description = metadataValue(html, ["description", "og:description", "twitter:description"]);
  const published = metadataValue(html, ["article:published_time", "datepublished"]);
  const image = metadataValue(html, ["og:image", "twitter:image"]);
  let mediaUrl: string | undefined;
  if (image) {
    try {
      mediaUrl = safeFeedUrl(new URL(image, url).toString(), "official").toString();
    } catch {
      // Unsafe or malformed metadata should not suppress an otherwise useful article.
    }
  }
  const title = htmlToBoundedText(titleHtml, 500) || "Nabu Casa news";
  return {
    title,
    url,
    publishedAt: published && !Number.isNaN(Date.parse(published)) ? new Date(published).toISOString() : articleDateFromUrl(url, lastModified),
    updatedAt: lastModified,
    author: null,
    body: description ? htmlToBoundedText(description, 12_000) : null,
    mediaUrls: mediaUrl ? [mediaUrl] : [],
  };
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
      const fetched = await fetchDocument(source, cache, fetcher, observedAt);
      if (fetched.warning) warnings.push(fetched.warning);
      if (source.format === "sitemap") {
        const articlePrefix = source.path_prefix!;
        const sitemapEntries = parseSitemap(fetched.body, { maxBytes: maximumFeedBytes })
          .filter((entry) => {
            const pathname = new URL(entry.loc).pathname;
            return pathname.startsWith(articlePrefix) && pathname !== articlePrefix;
          });
        return (await Promise.all(sitemapEntries.map(async (entry): Promise<StoredContentInput | undefined> => {
          const pageSource: FeedSourceConfig & { url: string } = {
            ...source,
            id: `${source.id}-page-${createHash("sha256").update(entry.loc).digest("hex").slice(0, 16)}`,
            url: entry.loc,
          };
          try {
            const page = await fetchDocument(pageSource, cache, fetcher, observedAt, "html");
            if (page.warning) warnings.push(page.warning);
            return {
              id: stableContentId(source.id, entry.loc, entry.loc),
              kind: "official_post",
              source: source.name,
              ...articleMetadata(page.body, entry.loc, entry.lastmod),
            };
          } catch (error) {
            warnings.push(`${source.name} article ${entry.loc} could not be collected: ${error instanceof Error ? error.message : String(error)}`);
            return undefined;
          }
        }))).filter((entry): entry is StoredContentInput => entry !== undefined);
      }
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

export const feedCollectorInternals = {
  safeFeedUrl,
  stableContentId,
  sourceFingerprint,
  googleAlertTarget,
  normalizedSource,
  responseTextWithinLimit,
  articleDateFromUrl,
  articleMetadata,
};
