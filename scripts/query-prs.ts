import { resolve, dirname } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { queryPullRequests, readPullRequestStore, type PullRequestQuery, type StoredPullRequest } from "../src/lib/pr-store";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const defaultStoreDirectory = resolve(root, "data/prs");

export const queryUsage = "Usage: node --import tsx scripts/query-prs.ts [--repo owner/repo] [--author login] [--label label] [--text phrase] [--since YYYY-MM-DD|ISO] [--before YYYY-MM-DD|ISO] [--limit N]";

export function parseQueryArguments(args: string[]): PullRequestQuery & { help?: boolean } {
  const query: PullRequestQuery & { help?: boolean } = {};
  const names: Record<string, keyof PullRequestQuery> = {
    "--repo": "repository",
    "--author": "author",
    "--label": "label",
    "--text": "text",
    "--since": "since",
    "--before": "before",
    "--limit": "limit",
  };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--help" || argument === "-h") {
      query.help = true;
      continue;
    }
    const property = names[argument];
    if (!property) throw new TypeError(`Unknown option: ${argument}\n${queryUsage}`);
    const value = args[index + 1];
    if (!value || value.startsWith("--")) throw new TypeError(`Missing value for ${argument}.\n${queryUsage}`);
    index += 1;
    if (property === "limit") {
      const limit = Number(value);
      if (!Number.isSafeInteger(limit) || limit < 1) throw new TypeError("--limit must be a positive integer.");
      query.limit = limit;
    } else {
      query[property] = value;
    }
  }
  return query;
}

export async function runPullRequestQuery(
  args: string[],
  storeDirectory = defaultStoreDirectory,
): Promise<StoredPullRequest[]> {
  const query = parseQueryArguments(args);
  if (query.help) return [];
  return queryPullRequests(await readPullRequestStore(storeDirectory), query);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const query = parseQueryArguments(args);
  if (query.help) {
    console.log(queryUsage);
    return;
  }
  const records = queryPullRequests(await readPullRequestStore(defaultStoreDirectory), query);
  console.log(JSON.stringify(records, null, 2));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
