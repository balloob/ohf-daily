import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { recordRoadmapObservation, type RoadmapItem, type RoadmapComment } from "./roadmap-store";

export interface RoadmapSourceConfig { enabled: boolean; project_id: string; url: string }
export type RoadmapGraphQL = <T>(query: string, variables: Record<string, unknown>) => Promise<T>;

function ghGraphQL(query: string, variables: Record<string, unknown>, env: NodeJS.ProcessEnv): Promise<unknown> {
  return new Promise((resolveRequest, reject) => {
    const child = spawn("gh", ["api", "graphql", "--input", "-"], { env, stdio: ["pipe", "pipe", "pipe"] });
    let output = "";
    // Never relay credential errors or raw API output to the publication or log.
    const timer = setTimeout(() => child.kill(), 60_000);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { output += chunk; });
    child.stderr.resume();
    child.on("error", () => { clearTimeout(timer); reject(new Error("GitHub CLI could not read the public roadmap.")); });
    child.on("close", (code) => {
      clearTimeout(timer);
      try {
        const response = JSON.parse(output);
        if (code !== 0 || response.errors?.length || !response.data) throw new Error();
        resolveRequest(response.data);
      } catch { reject(new Error("Public roadmap GraphQL request failed; check GitHub CLI authentication and read:project access.")); }
    });
    child.stdin.on("error", () => {});
    child.stdin.end(JSON.stringify({ query, variables }));
  });
}

export function createRoadmapGraphQL(env: NodeJS.ProcessEnv = process.env): RoadmapGraphQL {
  let activeEnv = env;
  return async <T>(query: string, variables: Record<string, unknown>): Promise<T> => {
    try { return await ghGraphQL(query, variables, activeEnv) as T; }
    catch (error) {
      if (!activeEnv.GH_TOKEN && !activeEnv.GITHUB_TOKEN) throw error;
      // Public collection tokens may lack Projects access. Use gh's configured
      // account via its supported environment behavior; never extract a token.
      const accountEnv = { ...env };
      delete accountEnv.GH_TOKEN;
      delete accountEnv.GITHUB_TOKEN;
      delete accountEnv.GH_ENTERPRISE_TOKEN;
      delete accountEnv.GITHUB_ENTERPRISE_TOKEN;
      const response = await ghGraphQL(query, variables, accountEnv) as T;
      activeEnv = accountEnv;
      return response;
    }
  };
}

const boardQuery = `query($projectId: ID!, $after: String) {
  node(id: $projectId) { ... on ProjectV2 {
    id public url
    items(first: 50, after: $after) {
      pageInfo { hasNextPage endCursor }
      nodes { id createdAt updatedAt
        fieldValues(first: 100) { pageInfo { hasNextPage } nodes {
          ... on ProjectV2ItemFieldSingleSelectValue { name field { ... on ProjectV2SingleSelectField { name } } }
          ... on ProjectV2ItemFieldTextValue { text field { ... on ProjectV2Field { name } } }
        } }
        content { __typename
          ... on Issue { id repository { isPrivate } }
          ... on DraftIssue { title body createdAt updatedAt }
        }
      }
    }
  } }
}`;
const issueQuery = `query($ids: [ID!]!) { nodes(ids: $ids) { ... on Issue {
  id title body url number createdAt updatedAt repository { nameWithOwner isPrivate }
  author { login ... on User { name } }
  comments(last: 20) { totalCount nodes { id url body createdAt updatedAt author { login ... on User { name } } } }
} } }`;

interface BoardItem {
  id: string; createdAt: string; updatedAt: string;
  fieldValues: { pageInfo: { hasNextPage: boolean }; nodes: Array<{ name?: string; text?: string; field?: { name: string } }> };
  content: null | { __typename: string; id?: string; repository?: { isPrivate: boolean }; title?: string; body?: string; createdAt?: string; updatedAt?: string };
}
interface BoardPage { node: null | { id: string; public: boolean; url: string; items: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: BoardItem[] } } }
interface IssueDetail {
  id: string; title: string; body: string; url: string; number: number; createdAt: string; updatedAt: string;
  author: { login: string; name?: string | null } | null;
  repository: { nameWithOwner: string; isPrivate: boolean };
  comments: { totalCount: number; nodes: Array<Omit<RoadmapComment, "author" | "authorName"> & { author: { login: string; name?: string | null } | null }> };
}

export async function fetchRoadmapItems(source: RoadmapSourceConfig, graphql: RoadmapGraphQL = createRoadmapGraphQL()): Promise<RoadmapItem[]> {
  const items: BoardItem[] = [];
  let after: string | null = null;
  const cursors = new Set<string>();
  do {
    const page: BoardPage = await graphql<BoardPage>(boardQuery, { projectId: source.project_id, after });
    if (!page.node || page.node.id !== source.project_id || page.node.public !== true || page.node.url !== source.url) throw new Error("Roadmap source must resolve to the configured public project.");
    for (const item of page.node.items.nodes) {
      if (item.fieldValues.pageInfo.hasNextPage) throw new Error("Roadmap fields were truncated; refusing a partial observation.");
      // Private/redacted issue bodies are never requested or persisted.
      if (item.content?.__typename === "DraftIssue" || (item.content?.__typename === "Issue" && item.content.repository?.isPrivate === false)) items.push(item);
    }
    if (!page.node.items.pageInfo.hasNextPage) break;
    after = page.node.items.pageInfo.endCursor;
    if (!after || cursors.has(after)) throw new Error("Roadmap pagination did not advance.");
    cursors.add(after);
  } while (true);
  const ids = items.filter((item) => item.content?.__typename === "Issue").map((item) => item.content!.id!);
  const details = new Map<string, IssueDetail>();
  for (let index = 0; index < ids.length; index += 30) {
    const requested = ids.slice(index, index + 30);
    const response = await graphql<{ nodes: Array<IssueDetail | null> }>(issueQuery, { ids: requested });
    if (response.nodes.length !== requested.length || response.nodes.some((node) => !node || !node.repository)) throw new Error("Roadmap public issue details were incomplete.");
    for (const node of response.nodes) if (node && node.repository.isPrivate === false) details.set(node.id, node);
  }
  return items.flatMap((item): RoadmapItem[] => {
    const content = item.content!;
    const issue = content.__typename === "Issue" ? details.get(content.id!) : undefined;
    if (content.__typename === "Issue" && !issue) return [];
    const fields = new Map(item.fieldValues.nodes.filter((field) => field.field).map((field) => [field.field!.name, field.name ?? field.text ?? null]));
    return [{ id: `roadmap:${item.id}`, itemId: item.id, projectId: source.project_id, projectUrl: source.url,
      type: issue ? "Issue" : "DraftIssue", title: issue?.title ?? content.title!, body: issue?.body ?? content.body!,
      url: issue?.url ?? source.url,
      author: issue?.author ? { login: issue.author.login, name: issue.author.name ?? null } : undefined,
      repository: issue?.repository.nameWithOwner ?? null, number: issue?.number ?? null,
      status: fields.get("Status") ?? null, mainProject: fields.get("Main Project") ?? null, area: fields.get("Area") ?? null,
      priority: fields.get("Priority") ?? null, deliveryStatus: fields.get("Delivery Status") ?? fields.get("DeliveryStatus") ?? null,
      itemCreatedAt: item.createdAt, itemUpdatedAt: item.updatedAt, contentCreatedAt: issue?.createdAt ?? content.createdAt!, contentUpdatedAt: issue?.updatedAt ?? content.updatedAt!,
      commentCount: issue?.comments.totalCount ?? 0,
      comments: issue?.comments.nodes.map((comment) => ({ ...comment, author: comment.author?.login ?? null, authorName: comment.author?.name ?? null })).sort((a, b) => a.id.localeCompare(b.id)) ?? [],
    }];
  });
}

export async function collectRoadmap(options: { root: string; source?: RoadmapSourceConfig; observedAt?: Date; graphql?: RoadmapGraphQL }): Promise<{ baseline: boolean; written: number; changed: number; items: number }> {
  if (!options.source?.enabled) return { baseline: false, written: 0, changed: 0, items: 0 };
  const items = await fetchRoadmapItems(options.source, options.graphql);
  const result = await recordRoadmapObservation(resolve(options.root, "data/roadmap"), options.source.project_id, items, options.observedAt);
  return { ...result, items: items.length };
}
