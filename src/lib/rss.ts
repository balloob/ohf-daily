import type { Article, Edition } from "./types";
import { articleSlug } from "../components/article-path";

export interface RssFeedOptions {
  site: URL;
  basePath: string;
  editions: Edition[];
  limit?: number;
}

function escapeXml(value: string): string {
  return value
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function normalizedBasePath(site: URL, basePath: string): string {
  if (basePath !== "/") return `/${basePath.replace(/^\/+|\/+$/g, "")}/`;
  const configuredPath = site.pathname.replace(/\/+$/, "");
  return configuredPath ? `${configuredPath}/` : "/";
}

function absoluteUrl(site: URL, basePath: string, path: string): string {
  const root = normalizedBasePath(site, basePath);
  return new URL(`${root}${path.replace(/^\/+/, "")}`, site.origin).toString();
}

function publicationDate(edition: Edition): Date {
  const candidate = new Date(edition.generatedAt || edition.windowEnd);
  if (!Number.isNaN(candidate.getTime()) && candidate.toISOString().startsWith(edition.date)) return candidate;
  return new Date(`${edition.date}T12:00:00Z`);
}

function itemXml(site: URL, basePath: string, edition: Edition, article: Article): string {
  const url = absoluteUrl(site, basePath, `edition/${edition.date}/article/${articleSlug(article.id)}/`);
  const description = [article.dek, article.body?.[0]].filter(Boolean).join(" ");
  const categories = (article.topics ?? []).map((topic) => `    <category>${escapeXml(topic)}</category>`).join("\n");

  return [
    "  <item>",
    `    <title>${escapeXml(article.title)}</title>`,
    `    <link>${escapeXml(url)}</link>`,
    `    <guid isPermaLink="true">${escapeXml(url)}</guid>`,
    `    <pubDate>${publicationDate(edition).toUTCString()}</pubDate>`,
    `    <description>${escapeXml(description)}</description>`,
    categories,
    "  </item>",
  ].filter(Boolean).join("\n");
}

export function buildRssFeed({ site, basePath, editions, limit = 50 }: RssFeedOptions): string {
  const publishedEditions = editions
    .filter((edition) => !edition.isDemo && (edition.articles?.length ?? 0) > 0)
    .sort((left, right) => right.date.localeCompare(left.date));
  const items = publishedEditions
    .flatMap((edition) => [...(edition.articles ?? [])]
      .sort((left, right) => right.score - left.score)
      .map((article) => ({ edition, article })))
    .slice(0, limit);
  const homeUrl = absoluteUrl(site, basePath, "");
  const feedUrl = absoluteUrl(site, basePath, "rss.xml");
  const lastBuildDate = items.length > 0 ? publicationDate(items[0].edition) : new Date(0);

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">',
    "<channel>",
    "  <title>OHF Daily</title>",
    `  <link>${escapeXml(homeUrl)}</link>`,
    "  <description>Daily reporting on the public open-source work moving the Open Home Foundation world forward.</description>",
    "  <language>en</language>",
    `  <lastBuildDate>${lastBuildDate.toUTCString()}</lastBuildDate>`,
    `  <atom:link href="${escapeXml(feedUrl)}" rel="self" type="application/rss+xml" />`,
    ...items.map(({ edition, article }) => itemXml(site, basePath, edition, article)),
    "</channel>",
    "</rss>",
    "",
  ].join("\n");
}

export const rssInternals = { absoluteUrl, escapeXml, normalizedBasePath };
