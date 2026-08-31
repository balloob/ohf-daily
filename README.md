# OHF Daily

OHF Daily is a newspaper-style account of the previous 24 hours across the Open Home Foundation ecosystem. It reports the changes that matter, keeps lower-signal merges in a concise wire, groups routine dependency updates, tracks upcoming releases, and preserves every edition in a year/month archive.

The static site is built with [Astro](https://astro.build/) for desktop and mobile and published through GitHub Pages. Coverage is configured for Home Assistant, **Home Assistant Libraries**, ESPHome, Music Assistant, the Open Home Foundation, OHF Voice, Matter.js, Z-Wave JS, Zigpy, and related public organizations.

## One-command editorial pipeline

The complete local pipeline is:

```sh
GH_TOKEN=github_pat_… OPENAI_API_KEY=sk-… npm run update
```

`npm run update` performs the whole newsroom run:

1. downloads merged pull requests for the edition's 24-hour window;
2. updates the local, queryable PR history in `data/prs/YYYY-MM.ndjson` (kept out of Git);
3. asks parallel reporter agents to investigate high-signal changes and relevant history;
4. produces a seven-day recap for Monday editions;
5. asks the editor agent to choose placement, combine related PRs, and write source-linked articles;
6. downloads selected GitHub images with strict size, host, and timeout limits and writes responsive WebP variants;
7. writes `data/editions/YYYY-MM-DD.json`, ready for Astro to build.

The reporter and editor may use text and media already present in public PRs. Every published article retains links to its underlying pull requests. Routine bumps stay available through the dependency dialog rather than taking over the front page.

Use `--date` to regenerate a specific edition. The date is interpreted in the configured `Europe/Amsterdam` timezone:

```sh
GH_TOKEN=github_pat_… OPENAI_API_KEY=sk-… npm run update -- --date 2026-08-30
```

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
- `prompts/weekly-recap.md` guides the Monday look-back across the preceding week;
- `prompts/editor.md` controls selection, grouping, placement, tone, and final article structure.
- `prompts/beats/*.md` adds organization-specific guidance without duplicating the shared evidence and tone rules.
- `prompts/tracks/*.md` defines cross-organization editorial lenses such as new devices, reliability, community, documentation, and releases.

Organizations answer **where to look**; editorial tracks answer **what story might be forming**. Tracks are never daily quotas. Reporter agents receive recent published-article context and may return no proposal when a track lacks evidence or ran too recently. The editor makes the final cadence decision, including whether a Monday beta/release preview adds enough beyond the release rail.

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

### Initial August history bootstrap

Populate the local database for all of August with one restart-safe command:

```sh
GH_TOKEN=github_pat_… npm run backfill -- --from 2026-08-01 --to 2026-08-31
```

Both endpoints are inclusive. Backfill starts with the newest date so recent material reaches the newsroom first, then works backward in bounded daily requests. It updates only `data/prs/YYYY-MM.ndjson` and the disposable GitHub cache, and never creates retroactive editions or invokes AI. Re-running the same range is safe: unchanged PRs are semantically deduplicated and do not create duplicate history records.

For the actual bootstrap, the manual GitHub Actions workflow is also available. Enter `2026-08-01` in `backfill_from` and `2026-08-31` in `backfill_to`. The workflow uses its built-in GitHub token and saves the database only in the private Actions cache. A failed run can be dispatched again with the same range.

## Editorial and release configuration

`data/sources.yaml` is the control room. It defines:

- GitHub organizations, display names, enablement, ranking weights, and featured repositories;
- labels and terms that affect story ranking or exclusion;
- recurring editorial tracks and their auditable prompt files;
- known dependency-update authors;
- reporting-window and front-page limits;
- Home Assistant and ESPHome release cycles;
- AI model, reasoning, concurrency, and history-query limits.

Every enabled organization costs at least one GitHub Search request per edition. Add or disable organizations in YAML; no collector change is necessary. If collection approaches rate limits, reduce `max_prs_per_organization`, disable low-signal sources, and preserve the API cache.

Home Assistant releases are calculated for the first Wednesday of each month. ESPHome follows two weeks later, and both beta periods begin seven days before release. Change `release_cycles` if the publication calendar changes.

## Site behavior

The newest edition is the home page. Older JSON files feed dated edition routes and the year/month archive. The release rail and all article sources remain available on every edition.

On desktop, supporting material such as dependency details opens in a contained dialog. On narrow mobile screens, dialogs become full-screen, keep their close control visible, and scroll internally so long lists do not move or overflow the newspaper behind them.

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

## GitHub tokens and cache

The workflow exposes the built-in `GITHUB_TOKEN` as `GH_TOKEN` for public GitHub collection. Organization searches explicitly filter to public repositories. No personal token is required in Actions. Locally, a fine-grained token with read-only access to public repositories is sufficient. Anonymous collection is supported by the low-level collector but usually exhausts its API limit during a full ecosystem run.

GitHub API responses and ETags live under `data/cache/`. Locally they survive between runs; Actions restores and saves that directory with `actions/cache`. Immutable PR details are reused, recent searches have a short freshness window, and stale cached responses may bridge a transient GitHub failure. The entire cache directory is ignored by Git—including binary downloads—while `data/cache/.gitkeep` preserves the directory.

Never put a GitHub or OpenAI token in YAML, prompts, an edition, or a PR shard.

## Daily automation and Pages setup

`.github/workflows/pages.yml` runs every day at `06:15 UTC`, which is `07:15` in Amsterdam in winter and `08:15` in summer. GitHub cron uses UTC and scheduled jobs may start a little late under load. A concurrency group serializes collection and deployment.

Scheduled production runs:

1. restore `data/cache/`;
2. require the `OPENAI_API_KEY` secret;
3. run `npm run update -- --require-ai`;
4. commit only the dated final edition; never commit the PR database or API cache;
5. build Astro with the origin and base path reported by GitHub Pages;
6. upload and deploy the static Pages artifact.

Pushes to `main` only build and deploy. If the repository uses another default branch, update `push.branches` in the workflow.

In the GitHub repository:

1. Open **Settings → Secrets and variables → Actions** and add a repository secret named `OPENAI_API_KEY`.
2. Optionally add an Actions variable named `OPENAI_MODEL` to override `data/sources.yaml` in automation.
3. Open **Settings → Pages** and set **Source** to **GitHub Actions**.
4. Open **Settings → Actions → General → Workflow permissions**, select **Read and write permissions**, and save. This authorizes commits of final edition JSON files.
5. Run **Collect and publish OHF Daily** manually once to verify collection, AI reporting, and deployment.

Manual runs support an optional edition date, demo mode, an explicit no-AI fallback, and “skip update” for deploy-only operation. A normal manual AI run fails with a clear setup message when `OPENAI_API_KEY` is absent. Scheduled runs never permit the no-AI switch.

The same form exposes `backfill_from` and `backfill_to`. Supplying either selects the history-only backfill branch; both valid dates are required, and the edition date/demo/AI inputs are ignored. The resulting database remains in the Actions cache and is not added to the repository.

## Dependabot

Dependabot checks npm packages and GitHub Actions weekly and groups each ecosystem's updates into one pull request. These maintenance PRs for OHF Daily are separate from the ecosystem dependency updates summarized in the newspaper.
