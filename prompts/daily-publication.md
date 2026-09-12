# Scheduled daily publication

The current assignment is to generate and publish the edition for the current `Europe/Amsterdam` date. The scheduled trigger runs at midnight UTC; these are deliberately different time zones.

Scheduling check: keep the schedule anchored to midnight UTC, independent of local timezone and daylight saving changes. Verify that the automation is actually saved and active, and that its next trigger is 00:00 UTC. A rendered proposal card alone is not an active schedule. If activation or timing cannot be verified, report that explicitly. Preserve the prompt, destination and notification preferences when updating the same automation. Small scheduler dispatch delays are acceptable; a several-hour timezone shift is not.

Read `AGENTS.md` and execute its Codex-native publication workflow. Do not answer an old conversation question or mistake an earlier edition's successful deployment for this run's completion. Prior conversation and summaries provide background, not the current assignment. Only a newer explicit user instruction can replace this task.

At the start, record the target date, reporting window once collected, and current stage in an ignored local checkpoint under `data/cache/publication-run.json`. Keep this checkpoint current after collection, reporting, editorial resolution, independent review, verification, commit, deployment, and Slack announcement. Preserve the exact plan path, unresolved blockers, commit SHA, workflow run ID, and announcement timestamp as they become available. Never store tokens or private feed URLs. After an interruption or context compaction, reread this file and this prompt, inspect the actual artifacts, and resume the pending stage. A checkpoint is a pointer to evidence, not proof by itself.

Run the single collector once per attempt; then use parallel bounded reporter subagents, a separate chief editor, and an independent final reviewer. Codex is the AI newsroom: no OpenAI API call or API key is required. Resolve the editor's plan against local sources and optimize selected media. Preserve unrelated changes and never publish placeholders, a deterministic fallback, or partial editorial content.

Before ending successfully, verify all of the following for the target date:

1. The dated edition exists and contains the resolved, independently reviewed editorial content.
2. The complete tests and production build succeed without unresolved warnings; selected media optimization reports zero failures.
3. Only the final dated edition and its selected optimized media are committed for this publication. Local histories, caches, `.env`, tokens, and private feed URLs remain ignored.
4. The exact publication commit is pushed to `main`, its Pages build and deployment succeed, and the live homepage, dated edition, articles, archive, RSS, and media return successfully and identify the target date where appropriate. A previous date, successful push alone, or framework-only deployment does not count.
5. Use the configured `open-home-slack` MCP for both checking Slack `#org-general` (channel ID `C08LJPEEJJD`) for the exact dated edition URL and posting the announcement. Do not use Slack's desktop or browser UI. If the MCP is unavailable, report the concrete connection problem and leave the announcement pending. If the URL has not already been announced, post one succinct sentence naming two or three real highlights followed by `https://paulusschoutsen.nl/ohf-daily/edition/YYYY-MM-DD/`. This scheduled task authorizes that post. Record the returned message timestamp; never post duplicates.

If any stage fails, report the target date, concrete failure, last completed stage, and what remains. Do not quietly mark an unfinished run complete. The final scheduled response must describe this edition's verified result or failure, never an unrelated earlier request. Keep unchanged monitoring state quiet; always notify on publication completion or a publication failure requiring attention.
