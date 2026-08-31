import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import YAML from "yaml";
import { htmlToBoundedText, parseFeed } from "./feed-parser";
import type { ReleasePreview } from "./types";

export type { ReleasePreview } from "./types";

export type ReleasePreviewStrategy = "direct" | "article_link" | "home_assistant_rc" | "esphome_next";

export interface ReleasePreviewSourceConfig {
  product: string;
  strategy?: ReleasePreviewStrategy;
  url?: string;
  metadata_url?: string;
  feed_url?: string;
  base_url?: string;
  article_link_pattern?: string;
  enabled?: boolean;
  max_chars?: number;
}

export interface ActiveReleaseTarget {
  product: string;
  version: string;
  releaseDate: string;
}

export interface ReleasePreviewCollectionResult {
  previews: ReleasePreview[];
  warnings: string[];
}

export interface ReleasePreviewCollectionOptions {
  root: string;
  sources: ReleasePreviewSourceConfig[];
  targets: ActiveReleaseTarget[];
  fetcher?: typeof fetch;
  now?: () => Date;
  timeoutMs?: number;
  maxResponseBytes?: number;
}

interface PreviewCacheEntry {
  url: string;
  fetchedAt: string;
  etag?: string;
  lastModified?: string;
  body: string;
}

interface PreviewCache {
  version: 1;
  entries: Record<string, PreviewCacheEntry>;
}

interface FetchedDocument {
  body: string;
  fetchedAt: string;
  warning?: string;
}

interface NormalizedSource extends ReleasePreviewSourceConfig {
  product: string;
  strategy: ReleasePreviewStrategy;
  max_chars: number;
  url?: string;
  metadata_url?: string;
  feed_url?: string;
  base_url?: string;
}

const DEFAULT_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_CHARS = 12_000;
const DEFAULT_TIMEOUT_MS = 30_000;

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1) throw new TypeError(`${name} must be a positive integer.`);
  return result;
}

function publicHttpsUrl(value: string, base?: string): URL {
  const url = base ? new URL(value, base) : new URL(value);
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new TypeError("Release preview URLs must use credential-free HTTPS.");
  }
  url.hash = "";
  url.hostname = url.hostname.toLowerCase();
  return url;
}

function cacheKey(url: string): string {
  return createHash("sha256").update(url).digest("hex").slice(0, 32);
}

async function readCache(path: string): Promise<PreviewCache> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as Partial<PreviewCache>;
    if (parsed.version === 1 && parsed.entries && typeof parsed.entries === "object") return parsed as PreviewCache;
  } catch {
    // A missing or malformed cache only costs an unconditional request.
  }
  return { version: 1, entries: {} };
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`);
  await rename(temporary, path);
}

async function responseTextWithinLimit(response: Response, maximum: number): Promise<string> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maximum) throw new Error(`Release preview response exceeds ${maximum} bytes.`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > maximum) throw new Error(`Release preview response exceeds ${maximum} bytes.`);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("Release preview response is not valid UTF-8.");
  }
}

async function fetchDocument(
  url: string,
  cache: PreviewCache,
  fetcher: typeof fetch,
  fetchedAt: string,
  timeoutMs: number,
  maxResponseBytes: number,
  documentKind: "html" | "metadata" | "feed" = "html",
): Promise<FetchedDocument> {
  const key = cacheKey(url);
  const cached = cache.entries[key]?.url === url ? cache.entries[key] : undefined;
  const accept = documentKind === "html"
    ? "text/html, application/xhtml+xml;q=0.9"
    : documentKind === "feed"
      ? "application/atom+xml, application/xml, text/xml;q=0.9"
      : "application/json, application/yaml, text/yaml, text/plain;q=0.9";
  const headers: Record<string, string> = { Accept: accept };
  if (cached?.etag) headers["If-None-Match"] = cached.etag;
  if (cached?.lastModified) headers["If-Modified-Since"] = cached.lastModified;

  try {
    const response = await fetcher(url, {
      headers,
      redirect: "follow",
      signal: AbortSignal.timeout(timeoutMs),
    });
    publicHttpsUrl(response.url || url);
    if (response.status === 304) {
      if (!cached) throw new Error("HTTP 304 without a cached response");
      cached.fetchedAt = fetchedAt;
      return { body: cached.body, fetchedAt };
    }
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
    const acceptedContentType = documentKind === "html"
      ? /(?:text\/html|application\/xhtml\+xml|text\/plain)/
      : documentKind === "feed"
        ? /(?:atom|xml|text\/plain)/
        : /(?:json|yaml|text\/plain|application\/octet-stream)/;
    if (contentType && !acceptedContentType.test(contentType)) {
      throw new Error(`unexpected content type ${contentType}`);
    }
    const body = await responseTextWithinLimit(response, maxResponseBytes);
    cache.entries[key] = {
      url,
      fetchedAt,
      etag: response.headers.get("etag") ?? undefined,
      lastModified: response.headers.get("last-modified") ?? undefined,
      body,
    };
    return { body, fetchedAt };
  } catch (error) {
    if (cached) {
      return {
        body: cached.body,
        fetchedAt: cached.fetchedAt,
        warning: `${url} could not be refreshed; cached release preview data was used.`,
      };
    }
    throw error;
  }
}

function htmlAttribute(tag: string, name: string): string | undefined {
  const quoted = tag.match(new RegExp(`(?:^|\\s)${name}\\s*=\\s*(["'])([\\s\\S]*?)\\1`, "i"));
  if (quoted) return quoted[2];
  return tag.match(new RegExp(`(?:^|\\s)${name}\\s*=\\s*([^\\s>]+)`, "i"))?.[1];
}

function decodeAttribute(value: string): string {
  return value
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

function metadataValue(html: string, keys: readonly string[]): string | undefined {
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    const key = (htmlAttribute(tag, "property") ?? htmlAttribute(tag, "name"))?.toLowerCase();
    if (key && keys.includes(key)) {
      const content = htmlAttribute(tag, "content");
      if (content) return decodeAttribute(content);
    }
  }
  return undefined;
}

function articleFragment(html: string): string {
  for (const tagName of ["article", "main", "body"]) {
    const match = html.match(new RegExp(`<${tagName}\\b[^>]*>([\\s\\S]*?)<\\/${tagName}\\s*>`, "i"));
    if (match) return match[1];
  }
  return html;
}

function readableBody(html: string, maximum: number): string {
  const fragment = articleFragment(html)
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(?:nav|header|footer|aside|form)\b[^>]*>[\s\S]*?<\/(?:nav|header|footer|aside|form)\s*>/gi, " ");
  return htmlToBoundedText(fragment, maximum);
}

function pageTitle(html: string, fallback: string): string {
  const value = metadataValue(html, ["og:title", "twitter:title"])
    ?? html.match(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/i)?.[1]
    ?? html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1\s*>/i)?.[1];
  return value ? htmlToBoundedText(value, 500) || fallback : fallback;
}

function pageMediaUrls(html: string, pageUrl: string): string[] {
  const candidates: string[] = [];
  const metadataImage = metadataValue(html, ["og:image", "twitter:image"]);
  if (metadataImage) candidates.push(metadataImage);
  const fragment = articleFragment(html);
  for (const tag of fragment.match(/<(?:img|source|video)\b[^>]*>/gi) ?? []) {
    const value = htmlAttribute(tag, "src") ?? htmlAttribute(tag, "poster");
    if (value) candidates.push(decodeAttribute(value));
  }
  return [...new Set(candidates.flatMap((candidate) => {
    try {
      return [publicHttpsUrl(candidate, pageUrl).toString()];
    } catch {
      return [];
    }
  }))];
}

function renderedArticlePattern(pattern: string, version: string): string {
  return pattern
    .replaceAll("{version}", version)
    .replaceAll("{version_compact}", version.replace(/[^a-z0-9]/gi, ""));
}

function discoverArticleUrl(indexHtml: string, indexUrl: string, pattern: string, version: string): string | undefined {
  const rendered = renderedArticlePattern(pattern, version);
  let expected: string | undefined;
  try {
    expected = publicHttpsUrl(rendered, indexUrl).toString();
  } catch {
    // A non-URL fragment pattern is matched literally against anchor hrefs.
  }
  for (const tag of indexHtml.match(/<a\b[^>]*>/gi) ?? []) {
    const rawHref = htmlAttribute(tag, "href");
    if (!rawHref) continue;
    const href = decodeAttribute(rawHref).trim();
    try {
      const resolved = publicHttpsUrl(href, indexUrl).toString();
      if ((expected && resolved === expected) || (!expected && href.includes(rendered))) return resolved;
    } catch {
      // Ignore unsafe, credentialed, and malformed anchors.
    }
  }
  return undefined;
}

function majorMinor(version: string): string {
  const match = version.trim().match(/^(\d{4})\.(\d{1,2})(?:\.|$)/);
  if (!match) throw new Error(`Release version ${version} is not in YYYY.M format.`);
  return `${Number(match[1])}.${Number(match[2])}`;
}

function verifyReleaseDate(value: unknown, releaseDate: string, label: string): void {
  const raw = String(value ?? "").trim();
  const timestamp = Date.parse(raw);
  if (!raw || !Number.isFinite(timestamp)) throw new Error(`${label} has an invalid date_released`);
  const metadataDate = /^\d{4}-\d{2}-\d{2}/.test(raw) ? raw.slice(0, 10) : new Date(timestamp).toISOString().slice(0, 10);
  if (metadataDate !== releaseDate.slice(0, 10)) throw new Error(`${label} release date ${metadataDate} does not match ${releaseDate.slice(0, 10)}`);
}

function versionAppears(entry: ReturnType<typeof parseFeed>[number], version: string): boolean {
  const token = majorMinor(version).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const expression = new RegExp(`(?:^|[^0-9])${token}(?:[^0-9]|$)`);
  return expression.test([entry.title, entry.url, entry.guid, entry.summary, entry.content].join(" "));
}

function isHomeAssistantReleaseEntry(entry: ReturnType<typeof parseFeed>[number], version: string): boolean {
  const [year, month] = majorMinor(version).split(".");
  const expectedSlug = `release-${year}${Number(month)}`;
  try {
    const url = publicHttpsUrl(entry.url);
    return (url.hostname === "www.home-assistant.io" || url.hostname === "rc.home-assistant.io")
      && url.pathname.split("/").filter(Boolean).at(-1) === expectedSlug;
  } catch {
    return false;
  }
}

function rewriteOrigin(value: string, fromHostname: string, toHostname: string): string {
  const url = publicHttpsUrl(value);
  if (url.hostname === fromHostname) url.hostname = toHostname;
  return url.toString();
}

function normalizedSource(source: ReleasePreviewSourceConfig): NormalizedSource {
  const product = source.product.trim();
  if (!product) throw new TypeError("Release preview sources require a product.");
  const strategy = source.strategy ?? (source.article_link_pattern ? "article_link" : "direct");
  if (!["direct", "article_link", "home_assistant_rc", "esphome_next"].includes(strategy)) {
    throw new TypeError(`Release preview source ${product} has an unsupported strategy.`);
  }
  const normalizeOptionalUrl = (value: string | undefined): string | undefined => value === undefined ? undefined : publicHttpsUrl(value.trim()).toString();
  const url = normalizeOptionalUrl(source.url);
  const metadataUrl = normalizeOptionalUrl(source.metadata_url);
  const feedUrl = normalizeOptionalUrl(source.feed_url);
  const baseUrl = normalizeOptionalUrl(source.base_url);
  const maxChars = positiveInteger(source.max_chars, DEFAULT_MAX_CHARS, `max_chars for ${product}`);
  if (source.article_link_pattern !== undefined && !source.article_link_pattern.trim()) {
    throw new TypeError(`article_link_pattern for ${product} cannot be empty.`);
  }
  if ((strategy === "direct" || strategy === "article_link") && !url) throw new TypeError(`Release preview source ${product} requires url.`);
  if (strategy === "article_link" && !source.article_link_pattern) throw new TypeError(`Release preview source ${product} requires article_link_pattern.`);
  if (strategy === "home_assistant_rc" && (!metadataUrl || !feedUrl)) {
    throw new TypeError(`Release preview source ${product} requires metadata_url and feed_url.`);
  }
  if (strategy === "esphome_next" && !metadataUrl) throw new TypeError(`Release preview source ${product} requires metadata_url.`);
  return {
    ...source,
    product,
    strategy,
    max_chars: maxChars,
    ...(url ? { url } : {}),
    ...(metadataUrl ? { metadata_url: metadataUrl } : {}),
    ...(feedUrl ? { feed_url: feedUrl } : {}),
    ...(baseUrl ? { base_url: baseUrl } : {}),
  };
}

function normalizedTarget(target: ActiveReleaseTarget): ActiveReleaseTarget {
  const product = target.product.trim();
  const version = target.version.trim();
  if (!product || !version) throw new TypeError("Active release targets require a product and version.");
  const releaseTimestamp = Date.parse(target.releaseDate);
  if (!Number.isFinite(releaseTimestamp)) throw new TypeError(`Active release target ${product}/${version} has an invalid release date.`);
  return { product, version, releaseDate: new Date(releaseTimestamp).toISOString() };
}

export async function collectReleasePreviews(options: ReleasePreviewCollectionOptions): Promise<ReleasePreviewCollectionResult> {
  const warnings: string[] = [];
  const timeoutMs = positiveInteger(options.timeoutMs, DEFAULT_TIMEOUT_MS, "timeoutMs");
  const maxResponseBytes = positiveInteger(options.maxResponseBytes, DEFAULT_MAX_RESPONSE_BYTES, "maxResponseBytes");
  const sources = new Map<string, NormalizedSource>();
  const enabledConfiguredProducts = new Set(options.sources
    .filter((source) => source.enabled !== false)
    .map((source) => source.product.trim())
    .filter(Boolean));
  for (const configured of options.sources.filter((source) => source.enabled !== false)) {
    try {
      const source = normalizedSource(configured);
      if (sources.has(source.product)) {
        warnings.push(`Release preview source ${source.product} is duplicated; the later source was skipped.`);
      } else {
        sources.set(source.product, source);
      }
    } catch (error) {
      warnings.push(error instanceof Error ? error.message : String(error));
    }
  }

  const targets = options.targets.flatMap((target) => {
    try {
      return [normalizedTarget(target)];
    } catch (error) {
      warnings.push(error instanceof Error ? error.message : String(error));
      return [];
    }
  });
  const cachePath = resolve(options.root, "data/cache/release-previews.json");
  const cache = await readCache(cachePath);
  const fetcher = options.fetcher ?? fetch;
  const fetchedAt = (options.now ?? (() => new Date()))().toISOString();

  const batches = await Promise.all(targets.map(async (target): Promise<{ preview?: ReleasePreview; warnings: string[] }> => {
    const source = sources.get(target.product);
    if (!source) return {
      warnings: enabledConfiguredProducts.has(target.product)
        ? []
        : [`No enabled release preview source is configured for ${target.product}.`],
    };
    const sourceWarnings: string[] = [];
    try {
      let pageUrl = "";
      let page: FetchedDocument;
      let title = "";
      let body = "";
      let mediaUrls: string[] = [];
      let effectiveFetchedAt = fetchedAt;
      if (source.strategy === "home_assistant_rc") {
        const [metadata, feed] = await Promise.all([
          fetchDocument(source.metadata_url!, cache, fetcher, fetchedAt, timeoutMs, maxResponseBytes, "metadata"),
          fetchDocument(source.feed_url!, cache, fetcher, fetchedAt, timeoutMs, maxResponseBytes, "feed"),
        ]);
        if (metadata.warning) sourceWarnings.push(metadata.warning);
        if (feed.warning) sourceWarnings.push(feed.warning);
        const parsed = YAML.parse(metadata.body, { maxAliasCount: 20 }) as unknown;
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Home Assistant RC metadata is not an object");
        const values = parsed as Record<string, unknown>;
        const metadataVersion = `${String(values.current_major_version ?? "").trim()}.${String(values.current_minor_version ?? "").trim()}`;
        if (metadataVersion !== majorMinor(target.version)) throw new Error(`RC metadata version ${metadataVersion} does not match ${target.version}`);
        verifyReleaseDate(values.date_released, target.releaseDate, "RC metadata");
        const matching = parseFeed(feed.body).find((entry) => isHomeAssistantReleaseEntry(entry, target.version));
        if (!matching) throw new Error(`RC feed has no entry matching ${target.version}`);
        pageUrl = rewriteOrigin(matching.url, "www.home-assistant.io", "rc.home-assistant.io");
        try {
          page = await fetchDocument(pageUrl, cache, fetcher, fetchedAt, timeoutMs, maxResponseBytes);
          if (page.warning) sourceWarnings.push(page.warning);
          title = pageTitle(page.body, matching.title);
          body = readableBody(page.body, source.max_chars);
          mediaUrls = pageMediaUrls(page.body, pageUrl)
            .map((url) => rewriteOrigin(url, "www.home-assistant.io", "rc.home-assistant.io"));
          effectiveFetchedAt = page.fetchedAt;
        } catch {
          sourceWarnings.push(`${pageUrl} could not be loaded; the RC feed content was used without relative media.`);
          title = matching.title;
          body = htmlToBoundedText(matching.content || matching.summary, source.max_chars);
          mediaUrls = matching.mediaUrls.map((url) => rewriteOrigin(url, "www.home-assistant.io", "rc.home-assistant.io"));
          effectiveFetchedAt = feed.fetchedAt;
        }
      } else if (source.strategy === "esphome_next") {
        const metadata = await fetchDocument(source.metadata_url!, cache, fetcher, fetchedAt, timeoutMs, maxResponseBytes, "metadata");
        if (metadata.warning) sourceWarnings.push(metadata.warning);
        const parsed = JSON.parse(metadata.body) as unknown;
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("ESPHome Next metadata is not an object");
        const values = parsed as Record<string, unknown>;
        const metadataVersion = typeof values.version === "string" ? values.version.trim() : "";
        if (majorMinor(metadataVersion) !== majorMinor(target.version)) throw new Error(`ESPHome Next version ${metadataVersion} does not match ${target.version}`);
        if (values.date_released !== undefined) verifyReleaseDate(values.date_released, target.releaseDate, "ESPHome Next metadata");
        if (typeof values.blog_url !== "string" || !values.blog_url.trim()) throw new Error("ESPHome Next metadata has no blog_url");
        const baseUrl = source.base_url ?? "https://next.esphome.io/";
        pageUrl = publicHttpsUrl(values.blog_url, baseUrl).toString();
        page = await fetchDocument(pageUrl, cache, fetcher, fetchedAt, timeoutMs, maxResponseBytes);
        if (page.warning) sourceWarnings.push(page.warning);
        title = pageTitle(page.body, `${target.product} ${target.version}`);
        body = readableBody(page.body, source.max_chars);
        mediaUrls = pageMediaUrls(page.body, pageUrl);
        effectiveFetchedAt = page.fetchedAt;
      } else if (source.strategy === "article_link") {
        const index = await fetchDocument(source.url!, cache, fetcher, fetchedAt, timeoutMs, maxResponseBytes);
        if (index.warning) sourceWarnings.push(index.warning);
        const discovered = discoverArticleUrl(index.body, source.url!, source.article_link_pattern!, target.version);
        if (!discovered) throw new Error(`no link matched ${renderedArticlePattern(source.article_link_pattern!, target.version)}`);
        pageUrl = discovered;
        page = await fetchDocument(pageUrl, cache, fetcher, fetchedAt, timeoutMs, maxResponseBytes);
      } else {
        pageUrl = source.url!;
        page = await fetchDocument(pageUrl, cache, fetcher, fetchedAt, timeoutMs, maxResponseBytes);
      }
      if (source.strategy === "direct" || source.strategy === "article_link") {
        if (page!.warning) sourceWarnings.push(page!.warning);
        title = pageTitle(page!.body, `${target.product} ${target.version}`);
        body = readableBody(page!.body, source.max_chars);
        mediaUrls = pageMediaUrls(page!.body, pageUrl);
        effectiveFetchedAt = page!.fetchedAt;
      }
      if (!body) throw new Error("official page did not contain readable text");
      const contentHash = createHash("sha256")
        .update(JSON.stringify({ title, url: pageUrl, body, mediaUrls }))
        .digest("hex");
      return {
        preview: {
          id: `${target.product}/${target.version}`,
          product: target.product,
          version: target.version,
          title,
          url: pageUrl,
          body,
          mediaUrls,
          contentHash,
          fetchedAt: effectiveFetchedAt,
          releaseDate: target.releaseDate,
        },
        warnings: sourceWarnings,
      };
    } catch (error) {
      sourceWarnings.push(`${target.product} ${target.version} release preview could not be collected: ${error instanceof Error ? error.message : String(error)}`);
      return { warnings: sourceWarnings };
    }
  }));

  await writeJsonAtomic(cachePath, cache);
  return {
    previews: batches.flatMap((batch) => batch.preview ? [batch.preview] : []),
    warnings: [...warnings, ...batches.flatMap((batch) => batch.warnings)],
  };
}

export const releasePreviewInternals = {
  publicHttpsUrl,
  responseTextWithinLimit,
  readableBody,
  pageTitle,
  pageMediaUrls,
  renderedArticlePattern,
  discoverArticleUrl,
  majorMinor,
  versionAppears,
  isHomeAssistantReleaseEntry,
  rewriteOrigin,
};
