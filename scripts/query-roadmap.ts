import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { queryRoadmap, readRoadmapStore, type RoadmapQuery } from "../src/lib/roadmap-store";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const roadmapQueryUsage = "Usage: npm run query:roadmap -- [--id roadmap:ITEM_ID] [--repo owner/repo] [--number N] [--status value] [--project value] [--text phrase] [--changed-since YYYY-MM-DD|ISO] [--before ISO] [--history] [--include-baseline] [--include-drafts] [--include-removed] [--limit N]";

export function parseRoadmapQueryArguments(args: string[]): RoadmapQuery & { help?: boolean } {
  const query: RoadmapQuery & { help?: boolean } = {};
  const switches = { "--history": "history", "--include-baseline": "includeBaseline", "--include-drafts": "includeDrafts", "--include-removed": "includeRemoved", "--help": "help", "-h": "help" } as const;
  const values = { "--id": "id", "--repo": "repository", "--number": "number", "--status": "status", "--project": "project", "--text": "text", "--changed-since": "changedSince", "--before": "before", "--limit": "limit" } as const;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const flag = switches[arg as keyof typeof switches];
    if (flag) { query[flag] = true; continue; }
    const property = values[arg as keyof typeof values];
    if (!property) throw new TypeError(`Unknown roadmap option: ${arg}.\n${roadmapQueryUsage}`);
    const value = args[++index];
    if (!value || value.startsWith("--")) throw new TypeError(`Missing value for ${arg}.`);
    if (property === "number" || property === "limit") {
      const number = Number(value);
      if (!Number.isSafeInteger(number) || number < 1) throw new TypeError(`${arg} must be a positive integer.`);
      query[property] = number;
    } else query[property] = value;
  }
  return query;
}

export async function runRoadmapQuery(args: string[], directory = resolve(root, "data/roadmap")) {
  const query = parseRoadmapQueryArguments(args);
  if (query.help) return [];
  // Keep older observations available for --before; the query chooses either
  // the latest state as of that cutoff or the full requested history.
  return queryRoadmap(await readRoadmapStore(directory, { history: true }), query);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  Promise.resolve().then(async () => {
    if (parseRoadmapQueryArguments(args).help) console.log(roadmapQueryUsage);
    else console.log(JSON.stringify(await runRoadmapQuery(args), null, 2));
  }).catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
}
