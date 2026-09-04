import { readFile, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { readContentStore } from "../src/lib/content-store";
import { editorialInternals } from "../src/lib/editorial";
import { readPullRequestStore } from "../src/lib/pr-store";
import type { Edition } from "../src/lib/types";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function editionDate(value: string | undefined): string {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new TypeError("Usage: npm run apply:editorial -- --date YYYY-MM-DD --plan /path/to/editor-plan.json");
  }
  return value;
}

async function main(): Promise<void> {
  const date = editionDate(argument("--date"));
  const planArgument = argument("--plan");
  if (!planArgument) throw new TypeError("--plan is required.");

  const editionPath = resolve(root, "data/editions", `${date}.json`);
  const planPath = resolve(process.cwd(), planArgument);
  const edition = JSON.parse(await readFile(editionPath, "utf8")) as Edition;
  if (edition.date !== date) throw new Error(`Edition date mismatch: expected ${date}, found ${edition.date}.`);

  const plan = JSON.parse(await readFile(planPath, "utf8")) as { articles?: unknown; events?: unknown };
  if (!Array.isArray(plan.articles)) throw new TypeError("Editorial plan must contain an articles array.");
  if (plan.events !== undefined && !Array.isArray(plan.events)) throw new TypeError("Editorial plan events must be an array when supplied.");
  const config = YAML.parse(await readFile(resolve(root, "data/sources.yaml"), "utf8")) as { event_horizon_days?: number };

  const pullRequests = await readPullRequestStore(resolve(root, "data/prs"));
  const storedContent = await readContentStore(resolve(root, "data/content"));
  const scheduledReleaseProducts = edition.releases
    .filter((event) => event.kind === "Release" && event.date === edition.date)
    .map((event) => event.product);
  const releasePreviews = (edition.releasePreviews ?? []).filter((preview) =>
    preview.releaseDate.slice(0, 10) === edition.date && scheduledReleaseProducts.includes(preview.product),
  );
  const missingReleasePreviews = scheduledReleaseProducts.filter((product) =>
    !releasePreviews.some((preview) => preview.product === product),
  );
  if (missingReleasePreviews.length > 0) {
    throw new Error(`Scheduled release day is missing an official preview for: ${missingReleasePreviews.join(", ")}`);
  }

  const releaseContent = releasePreviews.map(editorialInternals.releasePreviewContent);
  const articles = editorialInternals.resolveArticles(
    plan.articles as Parameters<typeof editorialInternals.resolveArticles>[0],
    pullRequests,
    [...storedContent, ...releaseContent],
    releaseContent.map((source) => source.id),
  );
  if (articles.length !== plan.articles.length) {
    throw new Error(`Editorial resolver accepted ${articles.length} of ${plan.articles.length} articles; refusing a partial edition.`);
  }
  if (articles.length > 0 && articles.filter((article) => article.placement === "lead").length !== 1) {
    throw new Error("Editorial plan must resolve to exactly one lead article.");
  }
  const events = editorialInternals.resolveEditorialEvents(
    (plan.events ?? []) as Parameters<typeof editorialInternals.resolveEditorialEvents>[0],
    storedContent,
    edition.date,
    config.event_horizon_days ?? 90,
  );

  edition.articles = articles;
  edition.releases = [...edition.releases.filter((event) => event.kind !== "Event"), ...events]
    .sort((left, right) => left.date.localeCompare(right.date));
  const temporaryPath = `${editionPath}.${process.pid}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(edition, null, 2)}\n`);
  await rename(temporaryPath, editionPath);
  console.log(`${date}: resolved ${articles.length} articles and ${events.length} calendar events from local evidence.`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
