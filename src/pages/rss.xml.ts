import type { APIRoute } from "astro";
import { editions } from "../lib/editions";
import { buildRssFeed } from "../lib/rss";

export const prerender = true;

export const GET: APIRoute = ({ site }) => new Response(buildRssFeed({
  site: site ?? new URL("https://balloob.github.io/ohf-daily/"),
  basePath: import.meta.env.BASE_URL,
  editions,
}), {
  headers: {
    "Content-Type": "application/rss+xml; charset=utf-8",
  },
});
