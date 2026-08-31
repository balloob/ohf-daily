import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import process from "node:process";

export interface FirstContribution {
  mergedAt: string;
  url: string;
  number: number;
}

export interface ContributorProfile {
  login: string;
  name: string | null;
  avatarUrl: string;
  profileUrl: string;
}

export interface ContributorDetails {
  firstContribution: FirstContribution;
  profile: ContributorProfile;
}

export interface ContributorCacheEntry extends FirstContribution {
  fetchedAt: string;
}

export interface ContributorProfileCacheEntry extends ContributorProfile {
  fetchedAt: string;
}

export interface ContributorCache {
  version: 1;
  repositories: Record<string, Record<string, ContributorCacheEntry>>;
  profiles: Record<string, ContributorProfileCacheEntry>;
}

interface GitHubReader {
  get<T>(url: string, options?: { immutable?: boolean; maxAgeMinutes?: number }): Promise<T>;
}

interface ContributorSearchResponse {
  incomplete_results: boolean;
  items: Array<{
    number: number;
    html_url: string;
    pull_request?: { merged_at?: string | null };
  }>;
}

interface GitHubUserResponse {
  login: string;
  name: string | null;
  avatar_url: string;
  html_url: string;
}

export function isBotLogin(login: string): boolean {
  return /(?:\[bot\]|bot$|^dependabot|^renovate|^github-actions|^pre-commit-ci)/i.test(login);
}

export async function loadContributorCache(path: string): Promise<ContributorCache> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as Partial<ContributorCache>;
    if (parsed.version === 1 && parsed.repositories && typeof parsed.repositories === "object") {
      return {
        version: 1,
        repositories: parsed.repositories,
        profiles: parsed.profiles && typeof parsed.profiles === "object" ? parsed.profiles : {},
      };
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, repositories: {}, profiles: {} };
    if (error instanceof SyntaxError) throw new Error(`Contributor cache is not valid JSON: ${path}`);
    throw error;
  }
  return { version: 1, repositories: {}, profiles: {} };
}

export async function saveContributorCache(path: string, cache: ContributorCache): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(cache, null, 2)}\n`);
  await rename(temporary, path);
}

export async function lookupFirstContribution(
  client: GitHubReader,
  cachePath: string,
  cache: ContributorCache,
  repository: string,
  author: string,
  now = new Date(),
): Promise<FirstContribution> {
  if (!repository || !author || author === "ghost" || isBotLogin(author)) throw new TypeError("First-contribution lookup requires a human repository author.");
  const cached = cache.repositories[repository]?.[author];
  if (cached) return { mergedAt: cached.mergedAt, url: cached.url, number: cached.number };

  const query = `repo:${repository} is:pr is:merged author:${author}`;
  const url = `https://api.github.com/search/issues?q=${encodeURIComponent(query)}&sort=created&order=asc&per_page=1`;
  const response = await client.get<ContributorSearchResponse>(url, { maxAgeMinutes: 60 * 24 * 30 });
  if (response.incomplete_results) throw new Error(`GitHub returned incomplete first-contribution results for ${repository} / ${author}.`);
  const first = response.items[0];
  const mergedAt = first?.pull_request?.merged_at;
  if (!first || !mergedAt || !Number.isSafeInteger(first.number)) throw new Error(`GitHub returned no merged contribution for ${repository} / ${author}.`);
  const entry: ContributorCacheEntry = { mergedAt, url: first.html_url, number: first.number, fetchedAt: now.toISOString() };
  cache.repositories[repository] ??= {};
  cache.repositories[repository][author] = entry;
  await saveContributorCache(cachePath, cache);
  return { mergedAt: entry.mergedAt, url: entry.url, number: entry.number };
}

function publicHttpsUrl(value: string, field: string, author: string): string {
  try {
    const url = new URL(value);
    if (url.protocol === "https:" && !url.username && !url.password) return url.toString();
  } catch {
    // Report a single useful validation error below.
  }
  throw new Error(`GitHub returned an invalid ${field} for ${author}.`);
}

export async function lookupContributorProfile(
  client: GitHubReader,
  cachePath: string,
  cache: ContributorCache,
  author: string,
  now = new Date(),
): Promise<ContributorProfile> {
  if (!author || author === "ghost" || isBotLogin(author)) throw new TypeError("Contributor profile lookup requires a human repository author.");
  const cacheKey = author.toLowerCase();
  const cached = cache.profiles[cacheKey];
  if (cached) return { login: cached.login, name: cached.name, avatarUrl: cached.avatarUrl, profileUrl: cached.profileUrl };

  const response = await client.get<GitHubUserResponse>(`https://api.github.com/users/${encodeURIComponent(author)}`, { maxAgeMinutes: 60 * 24 * 30 });
  if (!response.login) throw new Error(`GitHub returned no contributor profile for ${author}.`);
  const entry: ContributorProfileCacheEntry = {
    login: response.login,
    name: typeof response.name === "string" && response.name.trim() ? response.name.trim() : null,
    avatarUrl: publicHttpsUrl(response.avatar_url, "avatar URL", author),
    profileUrl: publicHttpsUrl(response.html_url, "profile URL", author),
    fetchedAt: now.toISOString(),
  };
  cache.profiles[cacheKey] = entry;
  await saveContributorCache(cachePath, cache);
  return { login: entry.login, name: entry.name, avatarUrl: entry.avatarUrl, profileUrl: entry.profileUrl };
}

export async function lookupContributorDetails(
  client: GitHubReader,
  cachePath: string,
  cache: ContributorCache,
  repository: string,
  author: string,
  now = new Date(),
): Promise<ContributorDetails> {
  const firstContribution = await lookupFirstContribution(client, cachePath, cache, repository, author, now);
  const profile = await lookupContributorProfile(client, cachePath, cache, author, now);
  return { firstContribution, profile };
}
