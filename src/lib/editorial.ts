import { readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import YAML from "yaml";
import { isBotLogin } from "./contributors";
import type { Article, ArticleMedia, ArticleSource, Edition } from "./types";
import { queryPullRequests, readPullRequestStore, type PullRequestQuery, type StoredPullRequest } from "./pr-store";
import type { ReleaseCycle } from "./releases";

interface AiConfig {
  model: string;
  reasoning_effort: "minimal" | "low" | "medium" | "high";
  max_parallel_reporters: number;
  max_history_queries_per_reporter: number;
}

interface EditorialTrackConfig {
  slug: string;
  name: string;
  prompt: string;
  enabled?: boolean;
}

export interface RecentPublishedArticle {
  date: string;
  title: string;
  topics: string[];
  kind: Article["kind"];
  placement: Article["placement"];
}

export interface ActiveBetaWindow {
  product: string;
  betaStart: string;
  releaseDate: string;
}

interface ReporterProposal {
  id: string;
  title: string;
  dek: string;
  body: string[];
  kind: "daily" | "weekly_recap";
  score: number;
  contributors: string[];
  topics: string[];
  continuity: string | null;
  pullRequestIds: string[];
  media: Array<{ type: "image" | "video"; url: string; alt: string; caption: string | null; poster: string | null }>;
}

interface EditorArticle extends ReporterProposal {
  placement: "lead" | "feature" | "brief";
}

interface ResponseOutputItem {
  type: string;
  name?: string;
  call_id?: string;
  arguments?: string;
}

interface ApiResponse {
  id: string;
  output_text?: string;
  output?: ResponseOutputItem[];
  error?: { message?: string };
}

interface EditorialOptions {
  root: string;
  editionPath: string;
  apiKey: string;
  modelOverride?: string;
  fetcher?: typeof fetch;
}

const proposalSchema = {
  type: "object",
  additionalProperties: false,
  required: ["proposals"],
  properties: {
    proposals: {
      type: "array",
      maxItems: 12,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "title", "dek", "body", "kind", "score", "contributors", "topics", "continuity", "pullRequestIds", "media"],
        properties: {
          id: { type: "string" },
          title: { type: "string" },
          dek: { type: "string" },
          body: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 5 },
          kind: { type: "string", enum: ["daily", "weekly_recap"] },
          score: { type: "number", minimum: 0, maximum: 100 },
          contributors: { type: "array", items: { type: "string" } },
          topics: { type: "array", items: { type: "string" } },
          continuity: { type: ["string", "null"] },
          pullRequestIds: { type: "array", items: { type: "string" }, minItems: 1 },
          media: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["type", "url", "alt", "caption", "poster"],
              properties: {
                type: { type: "string", enum: ["image", "video"] },
                url: { type: "string" },
                alt: { type: "string" },
                caption: { type: ["string", "null"] },
                poster: { type: ["string", "null"] },
              },
            },
          },
        },
      },
    },
  },
} as const;

const editorSchema = {
  type: "object",
  additionalProperties: false,
  required: ["articles"],
  properties: {
    articles: {
      type: "array",
      maxItems: 16,
      items: {
        ...(proposalSchema.properties.proposals.items as object),
        required: [...proposalSchema.properties.proposals.items.required, "placement"],
        properties: {
          ...proposalSchema.properties.proposals.items.properties,
          placement: { type: "string", enum: ["lead", "feature", "brief"] },
        },
      },
    },
  },
} as const;

const historyTool = {
  type: "function",
  name: "query_pr_history",
  description: "Query older merged pull requests in the local OHF Daily store. Use exact repository, author, or label filters when known. Results are local and require no GitHub request.",
  strict: true,
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["repository", "author", "label", "text", "since", "before", "limit"],
    properties: {
      repository: { type: ["string", "null"], description: "Exact owner/repository name." },
      author: { type: ["string", "null"], description: "Exact GitHub login." },
      label: { type: ["string", "null"], description: "Exact normalized label, for example integration: solaredge." },
      text: { type: ["string", "null"], description: "Case-insensitive title/body text search." },
      since: { type: ["string", "null"], description: "Optional ISO timestamp or YYYY-MM-DD lower bound." },
      before: { type: ["string", "null"], description: "Optional ISO timestamp or YYYY-MM-DD upper bound." },
      limit: { type: "integer", minimum: 1, maximum: 30 },
    },
  },
} as const;

function compactRecord(record: StoredPullRequest): object {
  return {
    id: String(record.id),
    number: record.number,
    repository: record.repository,
    organization: record.organization,
    title: record.title,
    description: (record.body ?? "").slice(0, 2400),
    author: record.author,
    authorProfile: record.authorProfile,
    mergedAt: record.mergedAt,
    labels: record.labels,
    mediaUrls: record.mediaUrls,
    stats: record.stats,
    isDependency: record.isDependency,
    firstContribution: record.firstContribution,
    isFirstContributionToRepository: record.isFirstContribution ?? false,
    url: record.url,
  };
}

async function apiRequest(fetcher: typeof fetch, apiKey: string, body: object): Promise<ApiResponse> {
  const response = await fetcher("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(180_000),
  });
  const payload = (await response.json()) as ApiResponse;
  if (!response.ok) throw new Error(`OpenAI Responses API returned ${response.status}: ${payload.error?.message ?? "unknown error"}`);
  return payload;
}

function nullable(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function historyQueryFromArguments(value: string | undefined): PullRequestQuery {
  const parsed = JSON.parse(value ?? "{}") as Record<string, unknown>;
  return {
    repository: nullable(parsed.repository),
    author: nullable(parsed.author),
    label: nullable(parsed.label),
    text: nullable(parsed.text),
    since: nullable(parsed.since),
    before: nullable(parsed.before),
    limit: typeof parsed.limit === "number" ? Math.min(parsed.limit, 30) : 10,
  };
}

async function runReporter(
  fetcher: typeof fetch,
  apiKey: string,
  model: string,
  effort: AiConfig["reasoning_effort"],
  instructions: string,
  input: object,
  history: StoredPullRequest[],
  maximumQueries: number,
): Promise<ReporterProposal[]> {
  let previousResponseId: string | undefined;
  let nextInput: unknown = JSON.stringify(input);
  let queryCount = 0;

  while (true) {
    const response = await apiRequest(fetcher, apiKey, {
      model,
      instructions,
      input: nextInput,
      previous_response_id: previousResponseId,
      reasoning: { effort },
      tools: [historyTool],
      parallel_tool_calls: true,
      text: { format: { type: "json_schema", name: "ohf_reporter_proposals", strict: true, schema: proposalSchema } },
      metadata: { publication: "ohf-daily", stage: "reporter" },
    });
    const calls = (response.output ?? []).filter((item) => item.type === "function_call" && item.name === "query_pr_history");
    if (calls.length === 0) {
      if (!response.output_text) throw new Error("Reporter returned neither tool calls nor structured output.");
      return (JSON.parse(response.output_text) as { proposals: ReporterProposal[] }).proposals;
    }
    if (queryCount + calls.length > maximumQueries) throw new Error(`Reporter exceeded its ${maximumQueries}-query local-history budget.`);
    queryCount += calls.length;
    nextInput = calls.map((call) => {
      const results = queryPullRequests(history, historyQueryFromArguments(call.arguments)).map(compactRecord);
      return { type: "function_call_output", call_id: call.call_id, output: JSON.stringify({ results }) };
    });
    previousResponseId = response.id;
  }
}

async function mapConcurrent<T, U>(items: T[], limit: number, mapper: (item: T) => Promise<U>): Promise<U[]> {
  const output = new Array<U>(items.length);
  let cursor = 0;
  async function worker(): Promise<void> {
    while (cursor < items.length) {
      const index = cursor++;
      output[index] = await mapper(items[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), items.length) }, () => worker()));
  return output;
}

function monday(date: string): boolean {
  return new Date(`${date}T12:00:00Z`).getUTCDay() === 1;
}

function daysBefore(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() - days);
  return value.toISOString();
}

export async function loadRecentPublishedArticles(
  editionDirectory: string,
  beforeDate: string,
  maximumEditions = 14,
): Promise<RecentPublishedArticle[]> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(beforeDate)) throw new TypeError("Recent article cutoff must use YYYY-MM-DD format.");
  if (!Number.isInteger(maximumEditions) || maximumEditions < 0) throw new TypeError("Recent edition limit must be a non-negative integer.");

  let filenames: string[];
  try {
    filenames = await readdir(editionDirectory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const selected = filenames
    .filter((filename) => /^\d{4}-\d{2}-\d{2}\.json$/.test(filename) && filename.slice(0, 10) < beforeDate)
    .sort((a, b) => b.localeCompare(a))
    .slice(0, maximumEditions);

  const editions = await Promise.all(selected.map(async (filename) => JSON.parse(
    await readFile(resolve(editionDirectory, filename), "utf8"),
  ) as Pick<Edition, "date" | "articles">));
  return editions.flatMap((published) => (published.articles ?? []).map((article) => ({
    date: published.date,
    title: article.title,
    topics: article.topics,
    kind: article.kind,
    placement: article.placement,
  })));
}

function trackPromptPath(root: string, prompt: string): string {
  return resolve(root, prompt.includes("/") ? prompt : `prompts/tracks/${prompt}`);
}

export function activeBetaWindows(date: string, releases: Edition["releases"], cycles: ReleaseCycle[]): ActiveBetaWindow[] {
  return cycles.flatMap((cycle) => {
    const release = releases.find((event) => event.product === cycle.product && event.kind === "Release" && event.date >= date);
    if (!release) return [];
    const betaStart = daysBefore(release.date, cycle.beta_days_before).slice(0, 10);
    return betaStart <= date && date < release.date ? [{ product: cycle.product, betaStart, releaseDate: release.date }] : [];
  });
}

function resolveArticles(raw: EditorArticle[], records: StoredPullRequest[]): Article[] {
  const byId = new Map(records.map((record) => [String(record.id), record]));
  const seen = new Set<string>();
  const articles: Article[] = [];
  for (const draft of raw) {
    const sources: ArticleSource[] = [...new Set(draft.pullRequestIds)].flatMap((id) => {
      const record = byId.get(String(id));
      return record ? [{ id: String(record.id), title: record.title, url: record.url, repository: record.repository }] : [];
    });
    if (sources.length === 0) continue;
    const allowedMedia = new Set(sources.flatMap((source) => byId.get(source.id)?.mediaUrls ?? []));
    const media: ArticleMedia[] = draft.media.flatMap((item) => allowedMedia.has(item.url) ? [{
      type: item.type,
      url: item.url,
      alt: item.alt,
      caption: nullable(item.caption),
      poster: item.poster && allowedMedia.has(item.poster) ? item.poster : undefined,
    }] : []);
    const id = draft.id.trim() || `article-${sources.map((source) => source.id).join("-")}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const sourceRecords = sources.flatMap((source) => {
      const record = byId.get(source.id);
      return record ? [record] : [];
    });
    const contributorProfiles = [...new Map(sourceRecords.flatMap((record) => {
      const profile = record.authorProfile;
      return profile ? [[profile.login.toLowerCase(), profile] as const] : [];
    })).values()];
    const uniqueLogins = (logins: string[]): string[] => {
      const seenLogins = new Set<string>();
      return logins.filter((login) => {
        const key = login.toLowerCase();
        if (seenLogins.has(key)) return false;
        seenLogins.add(key);
        return true;
      });
    };
    const contributors = uniqueLogins(sourceRecords
      .map((record) => record.author)
      .filter((login) => !isBotLogin(login)));
    const humanCredits = (field: "reviewers" | "approvers"): string[] => uniqueLogins(sourceRecords.flatMap((record) => record[field]
      .filter((login) => !isBotLogin(login) && login.toLowerCase() !== record.author.toLowerCase())));
    articles.push({
      id,
      title: draft.title.trim(),
      dek: draft.dek.trim(),
      body: draft.body.map((paragraph) => paragraph.trim()).filter(Boolean),
      kind: draft.kind,
      placement: draft.placement,
      score: Math.max(0, Math.min(100, draft.score)),
      contributors,
      contributorProfiles,
      reviewers: humanCredits("reviewers"),
      approvers: humanCredits("approvers"),
      topics: [...new Set(draft.topics.map((item) => item.trim()).filter(Boolean))],
      continuity: nullable(draft.continuity),
      pullRequests: sources,
      media,
    });
  }
  const daily = articles.filter((article) => article.kind === "daily").sort((a, b) => b.score - a.score);
  if (daily.length > 0) {
    const chosenLead = daily.find((article) => article.placement === "lead") ?? daily[0];
    for (const article of daily) if (article.placement === "lead" && article !== chosenLead) article.placement = "feature";
    chosenLead.placement = "lead";
  }
  return articles.sort((a, b) => ({ lead: 0, feature: 1, brief: 2 })[a.placement] - ({ lead: 0, feature: 1, brief: 2 })[b.placement] || b.score - a.score);
}

export async function runEditorial(options: EditorialOptions): Promise<Article[]> {
  const fetcher = options.fetcher ?? fetch;
  const config = YAML.parse(await readFile(resolve(options.root, "data/sources.yaml"), "utf8")) as {
    ai: AiConfig;
    organizations: Array<{ slug: string; name: string }>;
    editorial_tracks?: EditorialTrackConfig[];
    release_cycles: ReleaseCycle[];
  };
  const model = options.modelOverride ?? config.ai.model;
  const edition = JSON.parse(await readFile(options.editionPath, "utf8")) as Edition;
  const history = await readPullRequestStore(resolve(options.root, "data/prs"));
  const current = queryPullRequests(history, { since: edition.windowStart, before: edition.windowEnd, limit: 10_000 }).filter((record) => !record.isDependency);
  const recentPublishedArticles = await loadRecentPublishedArticles(dirname(options.editionPath), edition.date, 14);
  const releaseContext = {
    landedReleases: edition.landedReleases ?? [],
    upcomingEvents: edition.releases,
    activeBetas: activeBetaWindows(edition.date, edition.releases, config.release_cycles),
    cycles: config.release_cycles,
  };

  const reporterPrompt = await readFile(resolve(options.root, "prompts/reporter.md"), "utf8");
  const weeklyPrompt = await readFile(resolve(options.root, "prompts/weekly-recap.md"), "utf8");
  const editorPrompt = await readFile(resolve(options.root, "prompts/editor.md"), "utf8");
  const beats = [...Map.groupBy(current, (record) => record.organization).entries()].map(([beat, records]) => ({
    kind: "beat" as const,
    name: beat,
    records,
  }));
  const tracks = (config.editorial_tracks ?? []).filter((track) => track.enabled !== false).map((track) => ({
    kind: "track" as const,
    name: track.name,
    track,
    records: current,
  }));
  const reporterResults = await mapConcurrent([...beats, ...tracks], config.ai.max_parallel_reporters, async (assignment) => {
    let specificPrompt = "";
    if (assignment.kind === "track") {
      specificPrompt = await readFile(trackPromptPath(options.root, assignment.track.prompt), "utf8");
    } else {
      const organization = config.organizations.find((item) => item.name === assignment.name);
      if (organization) {
        try {
          specificPrompt = await readFile(resolve(options.root, "prompts/beats", `${organization.slug.toLowerCase()}.md`), "utf8");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
    }
    const pullRequests = assignment.records.map(compactRecord);
    return runReporter(
      fetcher,
      options.apiKey,
      model,
      config.ai.reasoning_effort,
      specificPrompt ? `${reporterPrompt}\n\n${specificPrompt}` : reporterPrompt,
      {
        edition: { date: edition.date, windowStart: edition.windowStart, windowEnd: edition.windowEnd },
        beat: assignment.name,
        editorialTrack: assignment.kind === "track" ? { slug: assignment.track.slug, name: assignment.track.name } : null,
        recentPublishedArticles,
        releaseContext,
        pullRequests,
      },
      history,
      config.ai.max_history_queries_per_reporter,
    );
  });
  const proposals = reporterResults.flat();

  if (monday(edition.date)) {
    const weeklyRecords = queryPullRequests(history, { since: daysBefore(edition.date, 7), before: edition.windowStart, limit: 10_000 }).filter((record) => !record.isDependency);
    if (weeklyRecords.length > 0) {
      proposals.push(...await runReporter(
        fetcher,
        options.apiKey,
        model,
        config.ai.reasoning_effort,
        `${reporterPrompt}\n\n${weeklyPrompt}`,
        {
          edition: { date: edition.date, recapStart: daysBefore(edition.date, 7), recapEnd: edition.windowStart },
          beat: "weekly recap",
          recentPublishedArticles,
          releaseContext,
          pullRequests: weeklyRecords.map(compactRecord),
        },
        history,
        config.ai.max_history_queries_per_reporter,
      ));
    }
  }

  if (proposals.length === 0) return [];

  const editorResponse = await apiRequest(fetcher, options.apiKey, {
    model,
    instructions: editorPrompt,
    input: JSON.stringify({
      edition: { date: edition.date, stats: edition.stats, isMonday: monday(edition.date) },
      recentPublishedArticles,
      releaseContext,
      proposals,
    }),
    reasoning: { effort: config.ai.reasoning_effort },
    text: { format: { type: "json_schema", name: "ohf_newspaper_plan", strict: true, schema: editorSchema } },
    metadata: { publication: "ohf-daily", stage: "editor" },
  });
  if (!editorResponse.output_text) throw new Error("Editor returned no structured newspaper plan.");
  const raw = (JSON.parse(editorResponse.output_text) as { articles: EditorArticle[] }).articles;
  const articles = resolveArticles(raw, history);
  edition.articles = articles;
  edition.notes = [...(edition.notes ?? []), `AI editorial plan generated with ${model} from auditable local prompts and ${history.length} stored pull requests.`];
  await writeFile(options.editionPath, `${JSON.stringify(edition, null, 2)}\n`);
  return articles;
}

export const editorialInternals = { monday, daysBefore, resolveArticles, historyQueryFromArguments, compactRecord, loadRecentPublishedArticles, activeBetaWindows };
