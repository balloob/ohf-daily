export type StoryKind = "feature" | "fix" | "platform" | "docs" | "maintenance";

export interface PullRequestStory {
  id: string;
  title: string;
  summary: string;
  unlocks?: string;
  url: string;
  repository: string;
  organization: string;
  author: string;
  mergedAt: string;
  labels: string[];
  kind: StoryKind;
  score: number;
  additions?: number;
  deletions?: number;
  changedFiles?: number;
  image?: string;
}

export interface DependencyItem {
  title: string;
  url: string;
  repository: string;
  author: string;
}

export interface ReleaseEvent {
  product: string;
  kind: "Beta" | "Release" | "Event";
  date: string;
  endDate?: string;
  version?: string;
  accent: string;
  url?: string;
  sourceId?: string;
}

export interface LandedRelease {
  id: string;
  product: string;
  repository: string;
  name: string;
  tag: string;
  url: string;
  publishedAt: string;
  channel: "stable" | "prerelease";
  accent: string;
  sourcePullRequestIds?: string[];
}

export interface ReleasePreview {
  id: string;
  product: string;
  version: string;
  title: string;
  url: string;
  body: string;
  mediaUrls: string[];
  contentHash: string;
  fetchedAt: string;
  releaseDate: string;
}

export interface ArticleSource {
  id: string;
  title: string;
  url: string;
  repository: string;
}

export interface ArticleExternalSource {
  id: string;
  title: string;
  url: string;
  publisher: string;
  publishedAt: string;
  kind: "official_post" | "external_coverage";
}

export interface ArticleMedia {
  type: "image" | "video";
  url: string;
  alt: string;
  caption?: string;
  poster?: string;
  width?: number;
  height?: number;
  variants?: ArticleMediaVariant[];
}

export interface ArticleMediaVariant {
  url: string;
  width: number;
  height: number;
  bytes: number;
  type: "image/webp";
}

export interface ContributorCredit {
  login: string;
  name: string | null;
  avatarUrl: string;
  profileUrl: string;
}

export interface Article {
  id: string;
  title: string;
  dek: string;
  body: string[];
  kind: "daily" | "weekly_recap";
  placement: "lead" | "feature" | "brief";
  score: number;
  contributors: string[];
  contributorProfiles?: ContributorCredit[];
  reviewers?: string[];
  approvers?: string[];
  topics: string[];
  continuity?: string;
  pullRequests: ArticleSource[];
  externalSources?: ArticleExternalSource[];
  media: ArticleMedia[];
}

export interface ProjectPulseItem {
  product: string;
  today: number;
  thisWeek: number;
  sinceRelease: number;
  lastReleaseDate: string | null;
}

export interface Edition {
  date: string;
  generatedAt: string;
  windowStart: string;
  windowEnd: string;
  timezone: string;
  isDemo?: boolean;
  stats: {
    mergedPullRequests: number;
    repositories: number;
    contributors: number;
    dependencyUpdates: number;
    hacsNewIntegrations?: number;
  };
  lead: PullRequestStory | null;
  highlights: PullRequestStory[];
  briefs: PullRequestStory[];
  dependencies: DependencyItem[];
  articles?: Article[];
  pulse?: ProjectPulseItem[];
  landedReleases?: LandedRelease[];
  releasePreviews?: ReleasePreview[];
  releases: ReleaseEvent[];
  notes?: string[];
}
