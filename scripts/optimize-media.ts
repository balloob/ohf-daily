import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import sharp from "sharp";
import type { ArticleMedia, ArticleMediaVariant, Edition } from "../src/lib/types";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const DEFAULT_WIDTHS = [480, 960, 1600] as const;
const ALLOWED_IMAGE_TYPES = new Set(["image/avif", "image/jpeg", "image/png", "image/webp"]);
const LOCAL_IMAGE_EXTENSION = /\.(?:avif|jpe?g|png|webp)$/i;
const GITHUB_USER_ASSET_HOST = "github-production-user-asset-6210df.s3.amazonaws.com";

export interface OptimizeMediaOptions {
  root: string;
  editionPath: string;
  fetcher?: typeof fetch;
  maxDownloadBytes?: number;
  timeoutMs?: number;
  widths?: readonly number[];
}

export interface OptimizeMediaResult {
  optimized: number;
  preserved: number;
  failed: number;
  bytesWritten: number;
}

export function isExternalImageUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password) return false;
    const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    if (hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local")) return false;
    const family = isIP(hostname);
    if (family === 4) {
      const [a, b] = hostname.split(".").map(Number);
      if (a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return false;
    }
    if (family === 6 && (hostname === "::1" || hostname === "::" || /^(?:fc|fd|fe[89ab])/i.test(hostname))) return false;
    return hostname === "github.com" || hostname.endsWith(".githubusercontent.com") || hostname === GITHUB_USER_ASSET_HOST;
  } catch {
    return false;
  }
}

export function responsiveWidths(sourceWidth: number, requested: readonly number[] = DEFAULT_WIDTHS): number[] {
  if (!Number.isFinite(sourceWidth) || sourceWidth < 1) return [];
  const valid = requested.filter((width) => Number.isInteger(width) && width > 0);
  if (valid.length === 0) return [];
  const capped = Math.min(Math.floor(sourceWidth), Math.max(...valid));
  return [...new Set([...valid.filter((width) => width < capped), capped])].sort((a, b) => a - b);
}

export function mediaStem(articleId: string, url: string): string {
  const slug = articleId.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 64) || "article";
  const hash = createHash("sha256").update(url).digest("hex").slice(0, 12);
  return `${slug}-${hash}`;
}

async function boundedDownload(url: string, fetcher: typeof fetch, maxBytes: number, timeoutMs: number): Promise<Buffer> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let currentUrl = url;
    let response: Response | undefined;
    for (let redirects = 0; redirects <= 5; redirects += 1) {
      if (!isExternalImageUrl(currentUrl)) throw new Error("disallowed media host");
      response = await fetcher(currentUrl, {
        redirect: "manual",
        signal: controller.signal,
        headers: { Accept: "image/avif,image/webp,image/png,image/jpeg", "User-Agent": "OHF-Daily-media-optimizer" },
      });
      if (![301, 302, 303, 307, 308].includes(response.status)) break;
      const location = response.headers.get("location");
      await response.body?.cancel();
      if (!location) throw new Error("redirect has no location");
      if (redirects === 5) throw new Error("too many redirects");
      currentUrl = new URL(location, currentUrl).href;
      response = undefined;
    }
    if (!response) throw new Error("media request did not complete");
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const contentType = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() ?? "";
    if (!ALLOWED_IMAGE_TYPES.has(contentType)) throw new Error(`unsupported content type ${contentType || "(missing)"}`);
    const contentLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(contentLength) && contentLength > maxBytes) throw new Error(`source exceeds ${maxBytes} bytes`);
    if (!response.body) throw new Error("empty response body");

    const chunks: Uint8Array[] = [];
    let total = 0;
    const reader = response.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error(`source exceeds ${maxBytes} bytes`);
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks, total);
  } finally {
    clearTimeout(timeout);
  }
}

function localMediaPath(publicDirectory: string, url: string): string | null {
  if (!url.startsWith("/") || url.includes("?") || url.includes("#") || !LOCAL_IMAGE_EXTENSION.test(url)) return null;
  const path = resolve(publicDirectory, url.replace(/^\/+/, ""));
  return path.startsWith(`${publicDirectory}${sep}`) ? path : null;
}

async function boundedLocalRead(path: string, maxBytes: number): Promise<Buffer> {
  const details = await stat(path);
  if (!details.isFile()) throw new Error("local media is not a file");
  if (details.size > maxBytes) throw new Error(`local source exceeds ${maxBytes} bytes`);
  return readFile(path);
}

async function convertImage(
  source: Buffer,
  outputDirectory: string,
  publicDirectory: string,
  stem: string,
  widths: readonly number[],
): Promise<{ url: string; width: number; height: number; variants: ArticleMediaVariant[]; bytes: number }> {
  const metadata = await sharp(source, { limitInputPixels: 40_000_000, failOn: "warning" }).metadata();
  if (!metadata.width || !metadata.height) throw new Error("image dimensions are unavailable");
  const targets = responsiveWidths(metadata.width, widths);
  if (targets.length === 0) throw new Error("image has invalid dimensions");
  await mkdir(outputDirectory, { recursive: true });

  const variants: ArticleMediaVariant[] = [];
  let bytes = 0;
  for (const width of targets) {
    const filename = `${stem}-${width}w.webp`;
    const outputPath = resolve(outputDirectory, filename);
    const temporaryPath = `${outputPath}.tmp`;
    const info = await sharp(source, { limitInputPixels: 40_000_000, failOn: "warning" })
      .rotate()
      .resize({ width, withoutEnlargement: true })
      .webp({ quality: 78, effort: 5, smartSubsample: true })
      .toFile(temporaryPath);
    await rename(temporaryPath, outputPath);
    const publicPath = `/${relative(publicDirectory, outputPath).split("\\").join("/")}`;
    variants.push({ url: publicPath, width: info.width, height: info.height, bytes: info.size, type: "image/webp" });
    bytes += info.size;
  }
  const largest = variants.at(-1)!;
  return { url: largest.url, width: largest.width, height: largest.height, variants, bytes };
}

export async function optimizeEditionMedia(options: OptimizeMediaOptions): Promise<OptimizeMediaResult> {
  const fetcher = options.fetcher ?? fetch;
  const maxBytes = options.maxDownloadBytes ?? 12 * 1024 * 1024;
  const timeoutMs = options.timeoutMs ?? 15_000;
  const widths = options.widths ?? DEFAULT_WIDTHS;
  const publicDirectory = resolve(options.root, "public");
  const edition = JSON.parse(await readFile(options.editionPath, "utf8")) as Edition;
  const outputDirectory = resolve(publicDirectory, "media", edition.date);
  const result: OptimizeMediaResult = { optimized: 0, preserved: 0, failed: 0, bytesWritten: 0 };
  let changed = false;

  for (const article of edition.articles ?? []) {
    for (let index = 0; index < article.media.length; index += 1) {
      const item = article.media[index] as ArticleMedia;
      if (item.type !== "image" || (item.variants?.length ?? 0) > 0) {
        result.preserved += 1;
        continue;
      }
      try {
        const localPath = localMediaPath(publicDirectory, item.url);
        if (!localPath && !isExternalImageUrl(item.url)) {
          result.preserved += 1;
          continue;
        }
        const source = localPath
          ? await boundedLocalRead(localPath, maxBytes)
          : await boundedDownload(item.url, fetcher, maxBytes, timeoutMs);
        const converted = await convertImage(source, outputDirectory, publicDirectory, mediaStem(article.id, item.url), widths);
        article.media[index] = { ...item, ...converted, variants: converted.variants };
        result.optimized += 1;
        result.bytesWritten += converted.bytes;
        changed = true;
      } catch (error) {
        result.failed += 1;
        console.warn(`Could not optimize media for ${article.id} (${item.url}): ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  if (changed) await writeFile(options.editionPath, `${JSON.stringify(edition, null, 2)}\n`);
  return result;
}

async function newestEditionPath(): Promise<string> {
  const directory = resolve(root, "data/editions");
  const { readdir } = await import("node:fs/promises");
  const files = (await readdir(directory)).filter((file) => /^\d{4}-\d{2}-\d{2}\.json$/.test(file)).sort();
  if (files.length === 0) throw new Error("No editions exist.");
  return resolve(directory, files.at(-1)!);
}

async function main(): Promise<void> {
  const pathArgument = process.argv.indexOf("--edition");
  const dateArgument = process.argv.indexOf("--date");
  const editionPath = pathArgument >= 0
    ? resolve(process.cwd(), process.argv[pathArgument + 1])
    : dateArgument >= 0
      ? resolve(root, "data/editions", `${process.argv[dateArgument + 1]}.json`)
      : await newestEditionPath();
  const result = await optimizeEditionMedia({ root, editionPath });
  const outputSize = result.bytesWritten === 0 ? "0 B" : `${(result.bytesWritten / 1024).toFixed(1)} KiB`;
  console.log(`Media: optimized ${result.optimized}, preserved ${result.preserved}, failed ${result.failed}; wrote ${outputSize}.`);
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
