export interface EditorialPullRequest {
  id: string;
  title: string;
  url: string;
  repository: string;
}

export interface EditorialExternalSource {
  id: string;
  title: string;
  url: string;
  publisher: string;
  publishedAt: string;
  kind: "official_post" | "external_coverage";
}

export interface EditorialMedia {
  type: "image" | "video";
  url: string;
  alt: string;
  caption?: string;
  poster?: string;
  width?: number;
  height?: number;
  variants?: Array<{
    url: string;
    width: number;
    height: number;
    bytes: number;
    type: "image/webp";
  }>;
}

export interface EditorialContributor {
  login: string;
  name: string | null;
  avatarUrl: string;
  profileUrl: string;
}

export interface EditorialArticle {
  id: string;
  title: string;
  dek: string;
  body: string[];
  kind: "daily" | "weekly_recap";
  placement: "lead" | "feature" | "brief";
  score: number;
  contributors: string[];
  contributorProfiles?: EditorialContributor[];
  reviewers?: string[];
  approvers?: string[];
  topics: string[];
  continuity?: string;
  pullRequests: EditorialPullRequest[];
  externalSources?: EditorialExternalSource[];
  media: EditorialMedia[];
}

export interface PulseItem {
  product: string;
  today: number;
  thisWeek: number;
  sinceRelease: number;
  lastReleaseDate: string | null;
}
