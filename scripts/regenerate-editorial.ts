import assert from "node:assert/strict";
import { readFile, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { runEditorial } from "../src/lib/editorial";
import { backfillDatesNewestFirst } from "./collect";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function deterministicFields(edition: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(edition).filter(([key]) => key !== "articles" && key !== "notes"));
}

async function regenerate(date: string, apiKey: string): Promise<void> {
  const editionPath = resolve(root, "data/editions", `${date}.json`);
  const originalText = await readFile(editionPath, "utf8");
  const before = JSON.parse(originalText) as Record<string, unknown> & { notes?: string[] };
  try {
    const articles = await runEditorial({ root, editionPath, apiKey, modelOverride: process.env.OPENAI_MODEL });
    if (articles.length === 0) throw new Error(`Editorial returned no articles for ${date}.`);
    const after = JSON.parse(await readFile(editionPath, "utf8")) as Record<string, unknown> & { notes?: string[] };
    assert.deepEqual(deterministicFields(after), deterministicFields(before), `Editorial changed deterministic edition data for ${date}.`);
    const generatedPrefix = "AI editorial plan generated";
    const preservedNotes = (before.notes ?? []).filter((note) => !note.startsWith(generatedPrefix));
    const latestGeneratedNote = (after.notes ?? []).filter((note) => note.startsWith(generatedPrefix)).at(-1);
    after.notes = [...preservedNotes, ...(latestGeneratedNote ? [latestGeneratedNote] : [])];
    const temporaryPath = `${editionPath}.${process.pid}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(after, null, 2)}\n`);
    await rename(temporaryPath, editionPath);
    console.log(`${date}: regenerated ${articles.length} articles from local PR history.`);
  } catch (error) {
    await writeFile(editionPath, originalText);
    throw error;
  }
}

async function main(): Promise<void> {
  const from = argument("--from");
  const to = argument("--to");
  if (!from || !to) throw new TypeError("Usage: npm run regenerate:editorial -- --from YYYY-MM-DD --to YYYY-MM-DD");
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY is required to regenerate editorial articles.");
  const dates = backfillDatesNewestFirst(from, to, "UTC").reverse();
  for (const date of dates) await regenerate(date, apiKey);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
