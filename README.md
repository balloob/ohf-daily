# OHF Daily

OHF Daily is a newspaper-style account of the previous 24 hours across the Open Home Foundation ecosystem. It reports the changes that matter across public code, official blogs, and corroborated outside coverage; groups routine dependency updates; tracks upcoming releases; and preserves every edition in a year/month archive.

The static site is built with [Astro](https://astro.build/) for desktop and mobile and published through GitHub Pages. Coverage is configured for Home Assistant, **Home Assistant Libraries**, HACS, ESPHome, Music Assistant, Sendspin, Improv Wi-Fi, the Open Home Foundation, OHF Voice, Matter.js, Z-Wave JS, Zigpy, and related public organizations.

## One-command editorial pipeline

The complete local pipeline is:

```sh
GH_TOKEN=github_pat_… OPENAI_API_KEY=sk-… npm run update
```

`npm run update` performs the whole newsroom run:

1. downloads merged pull requests plus configured official RSS/Atom feeds and optional Google Alert feeds for the edition's 24-hour window;
2. updates the local, queryable histories in `data/prs/YYYY-MM.ndjson` and `data/content/YYYY-MM.ndjson` (both kept out of Git);
3. asks parallel reporter agents to investigate high-signal changes and relevant local history;
4. produces a seven-day recap for Monday editions;
5. asks the editor agent to choose placement, combine related PRs, and write source-linked articles;
6. downloads selected GitHub images with strict size, host, and timeout limits and writes responsive WebP variants;
7. writes `data/editions/YYYY-MM-DD.json`, ready for Astro to build.

The reporter and editor may use text and media already present in public PRs and the text of collected official posts. Every published article retains links to its underlying pull requests, posts, and qualifying coverage. Routine dependency bumps stay in the edition data but never surface on the front page.

Use `--date` to regenerate a specific edition. The date is interpreted in the configured `Europe/Amsterdam` timezone:

```sh
GH_TOKEN=github_pat_… OPENAI_API_KEY=sk-… npm run update -- --date 2026-08-30
```

A requested date matching the current Amsterdam date uses the current instant as the end of its rolling 24-hour window. Past dates end at local midnight; future dates are rejected.

For an entirely local deterministic edition, explicitly disable AI:

```sh
GH_TOKEN=github_pat_… npm run update -- --no-ai
```

The no-AI path keeps the collector's ranked lead/highlights/briefs layout and adds an editor's note explaining the fallback. Without `--require-ai`, a missing key or failed AI call also falls back to that deterministic edition with a note. `--require-ai` instead makes either condition fatal; scheduled production uses this mode so a silently degraded edition is never published.

For a network-free visual preview:

```sh
npm run update -- --demo
npm run dev
```

Demo mode implies no AI and does not query GitHub.

Media optimization also runs for no-AI editions and can be repeated independently after manually editing an edition:

```sh
npm run optimize:media -- --date 2026-08-31
npm run optimize:media -- --edition data/editions/2026-08-31.json
```

Existing optimized media, videos, and unsupported URLs are left untouched. Selected remote images are accepted only from GitHub-owned media hosts, capped before and during download, decoded with a pixel limit, and emitted at mobile and desktop widths under `public/media/YYYY-MM-DD/`. The edition stores those variants for browser `srcset` selection, so phones do not download the desktop-sized image.

## AI configuration and prompts

Set `OPENAI_API_KEY` in the environment. The default model is `ai.model` in `data/sources.yaml`; set `OPENAI_MODEL` to override it for one run without editing tracked configuration:

```sh
OPENAI_API_KEY=sk-… OPENAI_MODEL=gpt-5-mini npm run update
```

`data/sources.yaml` also controls reasoning effort, reporter concurrency, and the maximum number of history queries each reporter may make. Keep concurrency modest when running locally or when API quotas are constrained.

The newsroom instructions are normal, reviewable Markdown files:

- `prompts/reporter.md` tells each daily beat reporter how to investigate and cite candidate PRs;
- `prompts/release-day.md` guides the mandatory headline article for a configured product's scheduled stable release day;
- `prompts/weekly-recap.md` guides the Monday look-back across the preceding week;
- `prompts/editor.md` controls selection, grouping, placement, tone, and final article structure.
- `prompts/editorial-review.md` gives an independent post-publication critic a repeatable human-relevance, writing, evidence, and placement rubric;
- `prompts/beats/*.md` adds organization-specific guidance without duplicating the shared evidence and tone rules.
- `prompts/tracks/*.md` defines cross-organization editorial lenses such as new devices, reliability, community, documentation, and releases.

Organizations answer **where to look**; editorial tracks answer **what story might be forming**. Tracks are never daily quotas. Reporter agents receive recent published-article context and may return no proposal when a track lacks evidence or ran too recently. A configured scheduled stable release day is the deliberate exception: its release article is the headline lead. Beta, prerelease, release-candidate, and patch coverage remains optional and must add enough human value beyond the release rail.

The collector performs a one-time GitHub lookup for each repository/author pair to identify a genuinely first merged contribution. It also fetches each contributor's public display name, avatar, and profile URL once, then keeps both results in the ignored local contributor cache. Those contributors receive a concise welcome in the article; the milestone is never guessed from the partial local PR history or by the model.

Edit prompts as editorial policy, not as a place for credentials or date-specific facts. Prompt changes are tracked in Git and are included by the publication workflow if a run updates them.

## Local PR database

Local PR history lives in monthly newline-delimited JSON shards under `data/prs/`. Collection appends revisions, and the read layer deduplicates them by GitHub PR ID, so reporters see the newest known record. The shards are deliberately ignored by Git; only the framework, prompts, and final edition JSON are published.

Query the database without calling GitHub:

```sh
node --import tsx scripts/query-prs.ts --repo home-assistant/core --label "integration: solaredge"
node --import tsx scripts/query-prs.ts --repo home-assistant/core --since 2026-08-01 --limit 25
node --import tsx scripts/query-prs.ts --author balloob --text matter
npm run query:prs -- --label solaredge
```

`--label` matches an exact label name, case-insensitively. Other filters are `--repo owner/repo`, `--author login`, `--text phrase`, `--since YYYY-MM-DD` (or an ISO timestamp), `--before YYYY-MM-DD` (or an ISO timestamp), and `--limit N`. Filters can be combined, and results are emitted as a JSON array on stdout for piping into other tools:

```sh
node --import tsx scripts/query-prs.ts --repo home-assistant/core --label "integration: solaredge" --since 2026-01-01 --limit 10 > /tmp/solaredge-prs.json
```

The monthly shards and `data/cache/` are local working data and are never committed. GitHub Actions persists them together through `actions/cache`; local runs keep them directly on disk.

## Official blogs and Google Alerts

Official publication sources are configured in `data/sources.yaml`. The initial set covers the Open Home Foundation blog and newsletter, Home Assistant's main and developer blogs, ESPHome, Music Assistant, Nabu Casa News, and Matter.js maintainer announcements. Nabu Casa does not publish RSS or Atom, so its official sitemap is filtered to `/news/` and each article's canonical metadata is collected directly. Projects without a genuine editorial source remain covered through GitHub and the umbrella OHF/Home Assistant publications; release feeds are not mislabeled as blogs.

Publication entries are stored as append-only monthly revisions under `data/content/`. This database is ignored by Git and cached privately in Actions, just like PR history. Only the source ledger of a selected article is written into the published edition. Feed collection preserves everything observed from now onward but cannot guarantee history older than a publisher still exposes; sitemap-backed sources can bootstrap the articles that remain listed.

Google Alerts are optional and private. In [Google Alerts](https://www.google.com/alerts), create the searches you want and, when the interface offers it, choose **Deliver to → RSS Feed**. Copy the generated feed URLs into one JSON array in `GOOGLE_ALERT_FEEDS_JSON`; never put those capability URLs in YAML, prompts, or edition data:

```sh
export GOOGLE_ALERT_FEEDS_JSON='[
  {"id":"open-home-foundation-mentions","name":"Open Home Foundation mentions","url":"https://www.google.com/alerts/feeds/…"},
  {"id":"home-assistant-mentions","name":"Home Assistant mentions","url":"https://www.google.com/alerts/feeds/…"}
]'
```

Each object requires a globally unique lowercase kebab-case `id`, a display `name`, and the exact HTTPS URL generated by Google. Only the `url` is secret: use public-safe IDs and names because diagnostics and published source ledgers may include them. Alert links are unwrapped to their original HTTPS target and published under that site's domain. Alerts are deliberately treated as discovery leads: an alert-only article is rejected unless a cited pull request or official post corroborates the underlying development. A malformed individual alert, missing secret, or temporarily unavailable feed fails softly and does not block the other feeds or the edition.

### Initial August history bootstrap

Populate the local database for all of August with one restart-safe command:

```sh
GH_TOKEN=github_pat_… npm run backfill -- --from 2026-08-01 --to 2026-08-31
```

Both endpoints are inclusive. Backfill starts with the newest date so recent material reaches the newsroom first, then works backward in bounded daily requests. It updates only `data/prs/YYYY-MM.ndjson` and the disposable GitHub cache, and never creates retroactive editions or invokes AI. Re-running the same range is safe: unchanged PRs are semantically deduplicated and do not create duplicate history records.

To backfill one newly added organization without rescanning every configured source, pass its configured slug or display name:

```sh
GH_TOKEN=github_pat_… npm run backfill -- --from 2026-08-01 --to 2026-08-31 --organization Sendspin
```

For the actual bootstrap, the manual GitHub Actions workflow is also available. Enter `2026-08-01` in `backfill_from` and `2026-08-31` in `backfill_to`. The workflow uses its built-in GitHub token and saves the database only in the private Actions cache. A failed run can be dispatched again with the same range.

## Editorial and release configuration

`data/sources.yaml` is the control room. It defines:

- GitHub organizations, display names, enablement, ranking weights, and featured repositories;
- labels and terms that affect story ranking or exclusion;
- recurring editorial tracks and their auditable prompt files;
- known dependency-update authors;
- reporting-window and front-page limits;
- Home Assistant and ESPHome release cycles;
- official release-preview sources and their product-specific lookup strategies;
- the 45-day upcoming-release horizon and explicit GitHub Release sources used by Release Radar;
- official blog and announcement feeds or sitemaps, their editorial desks, and enablement;
- AI model, reasoning, concurrency, and history-query limits.

Every enabled organization costs at least one GitHub Search request per edition. Add or disable organizations in YAML; no collector change is necessary. Project Pulse reuses the primary organizations' daily totals and performs three additional lightweight searches for authoritative seven-day totals, so its counts do not depend on local backfill completeness or the editorial detail limit. If collection approaches rate limits, reduce `max_prs_per_organization`, disable low-signal sources, and preserve the API cache.

Home Assistant releases are calculated for the first Wednesday of each month. ESPHome follows two weeks later, and both beta periods begin seven days before release. Change `release_cycles` if the publication calendar changes. `release_preview_sources` maps those products to their official preview material; Home Assistant uses its RC preview site and ESPHome uses its next-version site. Music Assistant can be added when its official preview URL and release cycle are known.

On a configured stable release day, the preview is ingested even when it was first published before the edition's 24-hour reporting window, and the resulting release article is the front-page lead. Preview notes are treated as mutable work in progress: they support the article's description of release themes, while only matching landed stable-release metadata permits wording that says the release is available. Betas, prereleases, release candidates, and patch releases remain discretionary unless their verified contents are independently newsworthy.

## Site behavior

The newest edition is the home page. Older JSON files feed dated edition routes and the year/month archive. The release rail shows actual releases published during the reporting window above a compact calendar capped at 45 days. Reported articles are also published as an RSS 2.0 feed at `/rss.xml`; the site advertises it through page metadata and a masthead link.

Dependency updates, editor diagnostics, and deterministic raw PR rankings do not appear on an AI-produced front page. If AI is unavailable, the raw ranked sections remain available as a fallback; scheduled production runs require AI.

HACS default-index additions are stored in local history but are never eligible article sources, including through AI history queries and weekly recaps. Each edition records an authoritative `stats.hacsNewIntegrations` total from a dedicated GitHub search; it is intentionally not rendered until the newsroom settles on the right recurring placement.

To work on the site without collecting again:

```sh
npm install
npm run dev
```

Before publishing:

```sh
npm test
npm run build
npm run preview
```

To test a GitHub project-site path locally:

```sh
SITE_URL=https://your-name.github.io BASE_PATH=/ohf-daily npm run build
```

To re-run only the editorial agents against the existing local PR database—without collecting GitHub again—set `OPENAI_API_KEY` and run dates chronologically:

```sh
npm run regenerate:editorial -- --from 2026-08-29 --to 2026-08-31
```

## GitHub tokens and cache

The workflow exposes the built-in `GITHUB_TOKEN` as `GH_TOKEN` for public GitHub collection. Organization searches explicitly filter to public repositories. No personal token is required in Actions. Locally, a fine-grained token with read-only access to public repositories is sufficient. Anonymous collection is supported by the low-level collector but usually exhausts its API limit during a full ecosystem run.

GitHub API responses and ETags live under `data/cache/`. Feed XML, ETags, and Last-Modified values use `data/cache/feeds.json`; release-note preview responses use `data/cache/release-previews.json` and are warmed throughout each configured beta week. Locally they survive between runs; manual Actions runs restore and save the cache directory plus both local history stores. Immutable PR details are reused, feeds are conditionally revalidated, and stale cached responses may bridge a transient upstream failure. The entire cache directory is ignored by Git—including binary downloads—while `data/cache/.gitkeep` preserves the directory.

Never put a GitHub/OpenAI token or Google Alert feed URL in YAML, prompts, an edition, or a history shard.

## Daily automation and Pages setup

The local Codex task **Generate daily OHF edition** runs at `07:00` in `Europe/Amsterdam`. It owns daily collection and publication so daylight-saving changes do not shift the newsroom and a second cloud schedule cannot overwrite the same edition.

Scheduled production runs:

1. reuse `data/cache/` plus the local PR and content history stores;
2. run the full `npm run update` newsroom with AI required for publication;
3. commit only dated publication data (the final edition and selected media); never commit either local database or the API/feed cache;
4. push to `main`, where `.github/workflows/pages.yml` builds Astro and deploys the static Pages artifact.

Pushes to `main` only build and deploy. The workflow can still be dispatched manually to regenerate an edition or backfill ignored local history using the private Actions cache. If the repository uses another default branch, update `push.branches` in the workflow.

In the GitHub repository:

1. Open **Settings → Secrets and variables → Actions** and add a repository secret named `OPENAI_API_KEY`.
2. Optionally add a secret named `GOOGLE_ALERT_FEEDS_JSON` containing the compact JSON array described above.
3. Optionally add an Actions variable named `OPENAI_MODEL` to override `data/sources.yaml` in automation.
4. Open **Settings → Pages** and set **Source** to **GitHub Actions**.
5. Open **Settings → Actions → General → Workflow permissions**, select **Read and write permissions**, and save. This authorizes commits of final edition JSON files.
6. Run **Collect and publish OHF Daily** manually once to verify collection, AI reporting, and deployment.

Manual runs support an optional edition date, demo mode, an explicit no-AI fallback, and “skip update” for deploy-only operation. A normal manual AI run fails with a clear setup message when `OPENAI_API_KEY` is absent. Scheduled runs never permit the no-AI switch.

The same form exposes `backfill_from` and `backfill_to`. Supplying either selects the history-only backfill branch; both valid dates are required, and the edition date/demo/AI inputs are ignored. The resulting database remains in the Actions cache and is not added to the repository.

## Dependabot

Dependabot checks npm packages and GitHub Actions weekly and groups each ecosystem's updates into one pull request. These maintenance PRs for OHF Daily are separate from the ecosystem dependency updates summarized in the newspaper.
