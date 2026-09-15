import { readFile, writeFile, rename } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { collectCommunityMeetups, type CommunityCalendarSource } from "../src/lib/community-meetups";
import type { Edition } from "../src/lib/types";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));

async function main() {
  const date = process.argv[process.argv.indexOf("--date") + 1];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date ?? "")) throw new Error("Usage: npm run refresh:meetups -- --date YYYY-MM-DD");
  const path = resolve(root, "data/editions", `${date}.json`);
  const edition = JSON.parse(await readFile(path, "utf8")) as Edition;
  if (edition.date !== date) throw new Error("Edition date mismatch.");
  const config = YAML.parse(await readFile(resolve(root, "data/sources.yaml"), "utf8")) as { community_calendar_sources?: CommunityCalendarSource[]; event_horizon_days?: number };
  edition.communityMeetups = await collectCommunityMeetups({
    sources: config.community_calendar_sources ?? [], editionDate: date,
    timeZone: edition.timezone, horizonDays: config.event_horizon_days ?? 90,
    cacheDirectory: resolve(root, "data/cache/community-calendars"),
  });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(edition, null, 2)}\n`);
  await rename(temporary, path);
  console.log(`${date}: refreshed ${edition.communityMeetups.length} community meetups; editorial content preserved.`);
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
