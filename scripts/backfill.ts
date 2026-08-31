import { resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { collectRange } from "./collect";

export const backfillUsage = "Usage: node --import tsx scripts/backfill.ts --from YYYY-MM-DD --to YYYY-MM-DD";

export function parseBackfillArguments(args: string[]): { from: string; to: string } {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument !== "--from" && argument !== "--to") throw new TypeError(`Unknown option: ${argument}\n${backfillUsage}`);
    const value = args[index + 1];
    if (!value || value.startsWith("--")) throw new TypeError(`Missing value for ${argument}.\n${backfillUsage}`);
    values.set(argument, value);
    index += 1;
  }
  const from = values.get("--from");
  const to = values.get("--to");
  if (!from || !to) throw new TypeError(`Both --from and --to are required.\n${backfillUsage}`);
  // collectRange performs calendar and ordering validation using the configured timezone.
  return { from, to };
}

async function main(): Promise<void> {
  const result = await collectRange(parseBackfillArguments(process.argv.slice(2)));
  console.log(`Backfilled ${result.days} day${result.days === 1 ? "" : "s"}; appended ${result.written} PR history revision${result.written === 1 ? "" : "s"}.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
