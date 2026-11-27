import { readFile, writeFile, rename } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { collectReleaseCalendar } from "../src/lib/release-calendar-feed";
import type { SourcesConfig } from "./collect";
import type { Edition } from "../src/lib/types";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
async function main() {
  const date = process.argv[process.argv.indexOf("--date") + 1];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date ?? "")) throw new Error("Usage: npm run refresh:releases -- --date YYYY-MM-DD");
  const path = resolve(root, "data/editions", `${date}.json`);
  const edition = JSON.parse(await readFile(path, "utf8")) as Edition;
  if (edition.date !== date) throw new Error("Edition date mismatch.");
  const config = YAML.parse(await readFile(resolve(root, "data/sources.yaml"), "utf8")) as SourcesConfig;
  if (!config.release_calendar_source) throw new Error("Missing release_calendar_source configuration.");
  const releases = await collectReleaseCalendar({
    source: config.release_calendar_source, editionDate: date, timeZone: edition.timezone,
    horizonDays: config.release_horizon_days ?? 45,
    cacheDirectory: resolve(root, "data/cache/release-calendar"), editionDirectory: resolve(root, "data/editions"),
  });
  edition.releases = [...releases, ...edition.releases.filter((event) => event.kind === "Event")].sort((a, b) => a.date.localeCompare(b.date));
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(edition, null, 2)}\n`);
  await rename(temporary, path);
  console.log(`${date}: refreshed ${releases.length} release/beta dates; articles and community events preserved.`);
}
main().catch((error) => { console.error(error.message); process.exitCode = 1; });
