# OHF Daily style guide

OHF Daily uses newspaper styling: importance is shown through size and position, every line adds something new, and nothing stands between the reader and the news.

## Writing

Every story appears under a project label. Readers already know the project before reaching the headline, so headlines and opening sentences must not repeat it at the start. Read the label, headline, subheading and opening together; each line should advance the story.

### Headlines

- Do not start with the project name. Lead with the change or the reader’s situation. Prefer “Find out what’s filling your database” to “Home Assistant shows what is filling its database.” A specific product or integration can still orient the reader: “Reolink recordings get a picture before you open them.”
- Make the headline readable on the first try. Avoid nouns that look like verbs and stacked clauses. Prefer “Restoring a Z-Wave backup protects the controller’s identity and keys” to “Z-Wave restores protect controller identity and update keys.” Prefer “Add DLNA speakers that don’t show up automatically” to “Music Assistant reaches DLNA players discovery misses.”
- Vary the shape; not every headline should be subject + verb + object.
- Scan the whole edition: no verb should lead more than one headline.
- Use words a non-developer understands. Technical names can appear in a headline when they identify the audience, but explain them in the article.
- Examples illustrate wording, not evidence. Preserve the source’s factual limits and release status; do not add “now” or other availability claims without release evidence.

### Subheadings

- Add a fact absent from the headline: who is affected, a limitation, or something to watch for.
- Do not restate the headline or reuse its key words merely to say the same thing again.

### Opening sentences

- Do not start with the project name.
- Do not repeat the headline or subheading. Start with a new detail or a concrete example of the problem being solved.
- For example: “If your database keeps growing, a new card in Storage shows which tables and entities are taking up the space.”
- Explain terms such as DLNA, RMT and ESP-IDF in plain words in the article, or leave them out. Keep exact configuration names when needed for a required action and explain their purpose.
- Retain enough natural project context in the dek or body for RSS and standalone article pages to make sense.

## Labels and order

- Use one consistent labelling scheme: project names, including Home Assistant, Music Assistant, ESPHome, Z-Wave JS and Voice. Use Voice rather than OHF Voice in visible labels. Reporting desks such as Devices must not replace independent project identities.
- Rank and select stories by impact on users, not project or pull-request count. Keep the existing evidence, repetition and release-day requirements.

## Layout

- Show people’s verified public names and profile pictures without an additional username. Do not invent or expand names that the public profile does not supply. When no public name exists, show @username beside the linked avatar.
- Include human reviewers and approvers in the credits, deduplicated with authors. Show just names and avatars below the linked text on the front page, without a bordered block or “With work by” prefix. Retain “With work by” on story detail pages. Preserve their distinct roles in the source data; exclude bots and self-review.
- Keep avatars close to text height so credits wrap compactly.
- Do not show counts such as “1 linked pull request” or “1 linked source” in story blocks. Make the headline, subheading and excerpt one article link, with no separate “Read more” link. Link each front-page article picture to the same story too. Keep contributor profile links separate. Exact source links remain on the article page.
- Let headlines wrap naturally across their available column width. Do not use `text-wrap: balance`, forced line breaks, or character-based headline width limits.
- Preserve newspaper hierarchy: a lead, larger features with excerpts, and compact briefs. Keep the wide feature column and two narrower brief columns on large screens, with stories starting immediately below the section heading. The calendar shares the right narrow column with briefs; balance briefs around its actual height instead of placing all text stories below the sidebar.
- Reserve the front-page drop cap for the lead. Avoid duplicate rules above Reported stories and Product direction; keep Product direction in the same bold label style as the project names.

- Brief subheadings use upright text. Their name/avatar credits sit below the linked copy without a bordered block or prefix.
- Hovering or keyboard-focusing a name/avatar enlarges the avatar in place to twice its size, without moving text or changing layout. Respect reduced-motion preferences.

- Story detail pages omit the visible “By OHF Daily · Automated reporting” line. Preserve the existing “With work by” text and credit-block styling there, and retain structured author metadata.
