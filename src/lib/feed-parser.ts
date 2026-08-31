import { TextDecoder } from "node:util";
import { XMLParser } from "fast-xml-parser";
import { SyntaxValidator } from "fast-xml-validator";

export interface FeedEntryInput {
  guid: string;
  title: string;
  url: string;
  publishedAt: string;
  updatedAt?: string;
  author?: string;
  summary: string;
  content: string;
  mediaUrls: string[];
}

export interface FeedParserOptions {
  maxBytes?: number;
  maxEntries?: number;
  maxTitleLength?: number;
  maxSummaryLength?: number;
  maxContentLength?: number;
}

export interface SitemapEntryInput {
  loc: string;
  lastmod: string;
}

export interface SitemapParserOptions {
  maxBytes?: number;
  maxEntries?: number;
}

const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_ENTRIES = 1_000;
const DEFAULT_MAX_TITLE_LENGTH = 500;
const DEFAULT_MAX_SUMMARY_LENGTH = 4_000;
const DEFAULT_MAX_CONTENT_LENGTH = 12_000;

const HTML_ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  apos: "'",
  gt: ">",
  hellip: "…",
  ldquo: "“",
  lsquo: "‘",
  lt: "<",
  mdash: "—",
  nbsp: " ",
  ndash: "–",
  quot: '"',
  rdquo: "”",
  rsquo: "’",
};

const TRACKING_PARAMETERS = new Set(["fbclid", "gclid", "mc_cid", "mc_eid"]);
const MEDIA_EXTENSION = /\.(?:avif|gif|jpe?g|mp4|m4v|mov|png|webm|webp)(?:$|[?#])/i;

type XmlRecord = Record<string, unknown>;

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1) throw new TypeError(`${name} must be a positive integer.`);
  return result;
}

function decodeHtmlEntities(value: string): string {
  return value.replace(/&(#(?:x[0-9a-f]+|\d+)|[a-z][a-z0-9]+);/gi, (match, entity: string) => {
    if (entity[0] === "#") {
      const hexadecimal = entity[1]?.toLowerCase() === "x";
      const codePoint = Number.parseInt(entity.slice(hexadecimal ? 2 : 1), hexadecimal ? 16 : 10);
      if (!Number.isSafeInteger(codePoint) || codePoint < 0 || codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff)) return "�";
      return String.fromCodePoint(codePoint);
    }
    return HTML_ENTITIES[entity.toLowerCase()] ?? match;
  });
}

function bounded(value: string, maximum: number): string {
  const characters = Array.from(value);
  if (characters.length <= maximum) return value;
  if (maximum === 1) return "…";
  return `${characters.slice(0, maximum - 1).join("").trimEnd()}…`;
}

export function htmlToBoundedText(value: string, maximum: number): string {
  const withoutUnsafeBlocks = value
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|template)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<(?:br|hr)\b[^>]*\/?>/gi, "\n")
    .replace(/<\/(?:address|article|aside|blockquote|div|figcaption|figure|footer|h[1-6]|header|li|main|nav|ol|p|pre|section|table|tr|ul)\s*>/gi, "\n")
    .replace(/<[^>]+>/g, " ");
  const decoded = decodeHtmlEntities(decodeHtmlEntities(withoutUnsafeBlocks))
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ")
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/ +([,.;:!?])/g, "$1")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return bounded(decoded, maximum);
}

function asArray<T>(value: T | T[] | undefined): T[] {
  return value === undefined ? [] : Array.isArray(value) ? value : [value];
}

function isRecord(value: unknown): value is XmlRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function child(record: XmlRecord, ...names: string[]): unknown {
  for (const name of names) if (record[name] !== undefined) return record[name];
  for (const name of names.filter((candidate) => !candidate.includes(":"))) {
    const atomName = `atom:${name}`;
    if (record[atomName] !== undefined) return record[atomName];
    const match = Object.keys(record).find((key) => key.endsWith(`:${name}`));
    if (match) return record[match];
  }
  return undefined;
}

function textValue(value: unknown): string {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.map(textValue).filter(Boolean).join(" ");
  if (!isRecord(value)) return "";
  if (typeof value["#text"] === "string") return value["#text"];
  return Object.entries(value)
    .filter(([key]) => !key.startsWith("@_") && key !== "__proto__" && key !== "constructor")
    .map(([, nested]) => textValue(nested))
    .filter(Boolean)
    .join(" ");
}

function attribute(record: XmlRecord, name: string): string | undefined {
  const value = record[`@_${name}`];
  return typeof value === "string" || typeof value === "number" ? String(value) : undefined;
}

function normalizedDate(value: unknown): string | undefined {
  const raw = textValue(value).trim();
  if (!raw) return undefined;
  const timestamp = Date.parse(raw);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : undefined;
}

function safeHttpsUrl(value: unknown, canonical = false): string | undefined {
  const raw = decodeHtmlEntities(textValue(value)).trim();
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" || url.username || url.password) return undefined;
    url.hash = "";
    url.hostname = url.hostname.toLowerCase();
    if (canonical) {
      for (const key of [...url.searchParams.keys()]) {
        const normalized = key.toLowerCase();
        if (normalized.startsWith("utm_") || TRACKING_PARAMETERS.has(normalized)) url.searchParams.delete(key);
      }
      url.searchParams.sort();
    }
    return url.toString();
  } catch {
    return undefined;
  }
}

function rawHtml(value: unknown): string {
  return typeof value === "string" ? value : textValue(value);
}

function embeddedMediaUrls(...values: unknown[]): string[] {
  const urls: string[] = [];
  for (const value of values) {
    const html = rawHtml(value);
    for (const match of html.matchAll(/<(?:img|source|video)\b[^>]+(?:src|poster)\s*=\s*["']([^"']+)["']/gi)) {
      const url = safeHttpsUrl(match[1]);
      if (url) urls.push(url);
    }
  }
  return urls;
}

function enclosureMediaUrls(record: XmlRecord): string[] {
  const urls: string[] = [];
  const visit = (value: unknown, key = ""): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item, key);
      return;
    }
    if (!isRecord(value)) return;

    const localName = key.toLowerCase().split(":").at(-1);
    const namespacedMedia = key.toLowerCase().startsWith("media:") && (localName === "content" || localName === "thumbnail");
    const enclosure = localName === "enclosure";
    if (namespacedMedia || enclosure) {
      const candidate = safeHttpsUrl(attribute(value, "url") ?? attribute(value, "href"));
      const type = (attribute(value, "type") ?? "").toLowerCase();
      const medium = (attribute(value, "medium") ?? "").toLowerCase();
      if (candidate && (namespacedMedia || type.startsWith("image/") || type.startsWith("video/") || medium === "image" || medium === "video" || MEDIA_EXTENSION.test(candidate))) {
        urls.push(candidate);
      }
    }
    for (const [nestedKey, nested] of Object.entries(value)) if (!nestedKey.startsWith("@_")) visit(nested, nestedKey);
  };
  visit(record);
  return urls;
}

function atomLink(record: XmlRecord): string | undefined {
  const links = asArray(child(record, "link", "atom:link")).filter(isRecord);
  const alternate = links.find((link) => {
    const rel = (attribute(link, "rel") ?? "alternate").toLowerCase();
    const type = (attribute(link, "type") ?? "text/html").toLowerCase();
    return rel === "alternate" && (!type || type.includes("html"));
  }) ?? links.find((link) => (attribute(link, "rel") ?? "alternate").toLowerCase() === "alternate");
  return alternate ? safeHttpsUrl(attribute(alternate, "href"), true) : undefined;
}

function atomEnclosures(record: XmlRecord): string[] {
  return asArray(child(record, "link", "atom:link")).filter(isRecord).flatMap((link) => {
    if ((attribute(link, "rel") ?? "").toLowerCase() !== "enclosure") return [];
    const candidate = safeHttpsUrl(attribute(link, "href"));
    const type = (attribute(link, "type") ?? "").toLowerCase();
    return candidate && (type.startsWith("image/") || type.startsWith("video/") || MEDIA_EXTENSION.test(candidate)) ? [candidate] : [];
  });
}

function rssLink(record: XmlRecord): string | undefined {
  const direct = safeHttpsUrl(child(record, "link"), true);
  if (direct) return direct;
  const guid = child(record, "guid");
  if (isRecord(guid) && (attribute(guid, "isPermaLink") ?? "true").toLowerCase() === "false") return undefined;
  return safeHttpsUrl(guid, true);
}

function authorName(record: XmlRecord): string | undefined {
  const author = child(record, "author", "dc:creator", "creator");
  const name = isRecord(author) ? textValue(child(author, "name")) : textValue(author);
  const normalized = htmlToBoundedText(name, 300);
  return normalized || undefined;
}

function normalizeEntry(record: XmlRecord, format: "rss" | "atom", options: Required<FeedParserOptions>): FeedEntryInput | undefined {
  const url = format === "atom" ? atomLink(record) : rssLink(record);
  if (!url) return undefined;

  const publishedAt = format === "atom"
    ? normalizedDate(child(record, "published")) ?? normalizedDate(child(record, "updated"))
    : normalizedDate(child(record, "pubDate", "published", "dc:date", "date")) ?? normalizedDate(child(record, "updated", "atom:updated"));
  if (!publishedAt) return undefined;
  const updatedAt = normalizedDate(child(record, "updated", "atom:updated"));

  const summaryValue = child(record, "summary", "description");
  const contentValue = child(record, "content:encoded", "encoded", "content");
  const summary = htmlToBoundedText(rawHtml(summaryValue ?? contentValue), options.maxSummaryLength);
  const content = htmlToBoundedText(rawHtml(contentValue ?? summaryValue), options.maxContentLength);
  const title = htmlToBoundedText(rawHtml(child(record, "title")), options.maxTitleLength);
  if (!title) return undefined;

  const rawGuid = textValue(child(record, "id", "guid")).trim();
  const guid = bounded(rawGuid.replace(/[\u0000-\u001f\u007f]/g, "").trim() || url, 2_048);
  const mediaUrls = [...new Set([
    ...atomEnclosures(record),
    ...enclosureMediaUrls(record),
    ...embeddedMediaUrls(summaryValue, contentValue),
  ])];
  const author = authorName(record);

  return {
    guid,
    title,
    url,
    publishedAt,
    ...(updatedAt && updatedAt !== publishedAt ? { updatedAt } : {}),
    ...(author ? { author } : {}),
    summary,
    content,
    mediaUrls,
  };
}

function requiredOptions(options: FeedParserOptions): Required<FeedParserOptions> {
  return {
    maxBytes: positiveInteger(options.maxBytes, DEFAULT_MAX_BYTES, "maxBytes"),
    maxEntries: positiveInteger(options.maxEntries, DEFAULT_MAX_ENTRIES, "maxEntries"),
    maxTitleLength: positiveInteger(options.maxTitleLength, DEFAULT_MAX_TITLE_LENGTH, "maxTitleLength"),
    maxSummaryLength: positiveInteger(options.maxSummaryLength, DEFAULT_MAX_SUMMARY_LENGTH, "maxSummaryLength"),
    maxContentLength: positiveInteger(options.maxContentLength, DEFAULT_MAX_CONTENT_LENGTH, "maxContentLength"),
  };
}

function sourceText(input: string | Uint8Array, maxBytes: number, documentName = "Feed"): string {
  const bytes = typeof input === "string" ? Buffer.byteLength(input, "utf8") : input.byteLength;
  if (bytes > maxBytes) throw new Error(`${documentName} XML exceeds the ${maxBytes}-byte limit.`);
  if (typeof input === "string") return input;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(input);
  } catch {
    throw new Error(`${documentName} XML is not valid UTF-8.`);
  }
}

export function parseFeed(input: string | Uint8Array, parserOptions: FeedParserOptions = {}): FeedEntryInput[] {
  const options = requiredOptions(parserOptions);
  const xml = sourceText(input, options.maxBytes);
  if (/<!DOCTYPE\b/i.test(xml)) throw new Error("Feed XML must not contain a DOCTYPE declaration.");

  try {
    SyntaxValidator.validate(xml, { allowBooleanAttributes: false });
  } catch (error) {
    throw new Error(`Malformed feed XML: ${error instanceof Error ? error.message : String(error)}`);
  }

  let parsed: unknown;
  try {
    parsed = new XMLParser({
      allowBooleanAttributes: false,
      attributeNamePrefix: "@_",
      ignoreAttributes: false,
      parseAttributeValue: false,
      parseTagValue: false,
      processEntities: true,
      trimValues: false,
    }).parse(xml);
  } catch (error) {
    throw new Error(`Malformed feed XML: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isRecord(parsed)) throw new Error("Feed XML does not contain an RSS or Atom document.");

  const rss = child(parsed, "rss");
  const atom = child(parsed, "feed", "atom:feed");
  let rawRecords: unknown[];
  let records: XmlRecord[];
  let format: "rss" | "atom";
  if (isRecord(rss) && isRecord(child(rss, "channel"))) {
    rawRecords = asArray(child(child(rss, "channel") as XmlRecord, "item"));
    records = rawRecords.filter(isRecord);
    format = "rss";
  } else if (isRecord(atom)) {
    rawRecords = asArray(child(atom, "entry", "atom:entry"));
    records = rawRecords.filter(isRecord);
    format = "atom";
  } else {
    throw new Error("Feed XML does not contain an RSS 2.0 channel or Atom feed.");
  }
  if (rawRecords.length > options.maxEntries) throw new Error(`Feed XML exceeds the ${options.maxEntries}-entry limit.`);
  return records.flatMap((record) => {
    const normalized = normalizeEntry(record, format, options);
    return normalized ? [normalized] : [];
  });
}

export function parseSitemap(input: string | Uint8Array, parserOptions: SitemapParserOptions = {}): SitemapEntryInput[] {
  const maxBytes = positiveInteger(parserOptions.maxBytes, DEFAULT_MAX_BYTES, "maxBytes");
  const maxEntries = positiveInteger(parserOptions.maxEntries, DEFAULT_MAX_ENTRIES, "maxEntries");
  const xml = sourceText(input, maxBytes, "Sitemap");
  if (/<!DOCTYPE\b/i.test(xml)) throw new Error("Sitemap XML must not contain a DOCTYPE declaration.");

  try {
    SyntaxValidator.validate(xml, { allowBooleanAttributes: false });
  } catch (error) {
    throw new Error(`Malformed sitemap XML: ${error instanceof Error ? error.message : String(error)}`);
  }

  let parsed: unknown;
  try {
    parsed = new XMLParser({
      allowBooleanAttributes: false,
      attributeNamePrefix: "@_",
      ignoreAttributes: false,
      parseAttributeValue: false,
      parseTagValue: false,
      processEntities: true,
      trimValues: false,
    }).parse(xml);
  } catch (error) {
    throw new Error(`Malformed sitemap XML: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isRecord(parsed)) throw new Error("Sitemap XML does not contain a URL set.");

  const urlset = child(parsed, "urlset");
  if (!isRecord(urlset)) throw new Error("Sitemap XML does not contain a URL set.");
  const rawRecords = asArray(child(urlset, "url"));
  if (rawRecords.length > maxEntries) throw new Error(`Sitemap XML exceeds the ${maxEntries}-entry limit.`);

  return rawRecords.filter(isRecord).flatMap((record) => {
    const loc = safeHttpsUrl(child(record, "loc"), true);
    const lastmod = normalizedDate(child(record, "lastmod"));
    return loc && lastmod ? [{ loc, lastmod }] : [];
  });
}

export const feedParserInternals = { htmlToBoundedText, safeHttpsUrl };
