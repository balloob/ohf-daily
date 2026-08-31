import { readdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { collect } from "./collect";
import { runEditorial } from "../src/lib/editorial";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));

function has(name: string): boolean {
  return process.argv.includes(name);
}

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function newestEditionPath(): Promise<string> {
  const files = (await readdir(resolve(root, "data/editions"))).filter((file) => /^\d{4}-\d{2}-\d{2}\.json$/.test(file)).sort();
  if (files.length === 0) throw new Error("Collector did not create an edition.");
  return resolve(root, "data/editions", files.at(-1)!);
}

async function addNote(path: string, note: string): Promise<void> {
  const edition = JSON.parse(await readFile(path, "utf8")) as { notes?: string[] };
  edition.notes = [...(edition.notes ?? []).filter((item) => !item.startsWith("AI editorial step")), note];
  await writeFile(path, `${JSON.stringify(edition, null, 2)}\n`);
}

async function update(): Promise<void> {
  if (has("--no-ai") && has("--require-ai")) throw new Error("--no-ai and --require-ai cannot be used together.");
  await collect();
  const requested = argument("--date");
  const editionPath = requested ? resolve(root, "data/editions", `${requested}.json`) : await newestEditionPath();
  if (has("--demo") || has("--no-ai")) {
    await addNote(editionPath, "AI editorial step was intentionally skipped; deterministic ranking is shown.");
    return;
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    if (has("--require-ai")) throw new Error("OPENAI_API_KEY is required for the scheduled editorial run.");
    await addNote(editionPath, "AI editorial step was skipped because OPENAI_API_KEY is not configured; deterministic ranking is shown.");
    return;
  }

  try {
    const articles = await runEditorial({ root, editionPath, apiKey, modelOverride: process.env.OPENAI_MODEL });
    console.log(`Editorial agents produced ${articles.length} grouped articles.`);
  } catch (error) {
    if (has("--require-ai")) throw error;
    console.warn(`AI editorial step failed: ${error instanceof Error ? error.message : String(error)}`);
    await addNote(editionPath, "AI editorial step failed; deterministic ranking is shown for this edition.");
  }
}

update().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
