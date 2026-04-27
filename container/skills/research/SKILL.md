---
name: research
description: >
  Multi-source research that searches the web, Reddit, GitHub, and documentation
  to produce structured research reports saved to the Obsidian vault. Three depth
  tiers: quick (factual lookups, ~2min), standard (comparisons and implementation
  questions, ~6-8min), deep (comprehensive investigations with follow-up loops and
  adversarial critique, ~12-15min). Use this skill when the user asks to research
  a topic, investigate options, compare technologies, find community opinions, or
  gather information for planning and decision-making. Also use when the user says
  "research", "investigate", "what do people think about", "find out about",
  "look into", "quick research", or "deep research".
metadata:
  author: mzazon
  version: "6.0.0-container"
context: fork
allowed-tools: >
  Read Write Bash WebSearch WebFetch Task TaskOutput TaskStop
compatibility: >
  Requires: reddit-search API (host.docker.internal:11237), vault-search (host.docker.internal:11236).
  Optional: gh CLI for GitHub discovery. Uses Claude built-in WebSearch and
  WebFetch with markdown.new proxy for token-efficient page reading.
  Worker and critic instructions are inlined in this skill (no separate agent definitions).
---

# Research

Orchestrate multi-source research and produce a structured report in the Obsidian vault.

## Invocation

When you receive a research request, determine the source and follow the appropriate path:

### Path A: #research forum channel (direct)
When the request arrives from a #research forum thread (the user posted directly), classify the tier and execute all phases in that thread. Each forum post is a separate research session.

### Path B: Agent-dispatched (from Otto or another agent)
When the request arrives from another agent (e.g., Otto via inter-agent message), the **CLAUDE.local.md routing section handles thread creation and result delivery**. Do NOT call `create_forum_thread` here — it was already called before this skill was invoked. Just execute the research phases below and let CLAUDE.local.md handle the messaging.

## Tier Classification

Before starting research, classify the query into a tier. The user can override by saying "quick", "standard", or "deep".

| Signal | Tier |
|--------|------|
| Factual lookup, single-answer question ("what version of X supports Y?") | Quick |
| Comparison, implementation question, "how should I..." | Standard |
| Complex investigation, "evaluate", "what do people think", multi-faceted | Deep |
| User says "quick" / "just a quick check" | Quick (override) |
| User says "deep" / "thorough" / "comprehensive" | Deep (override) |

**Announce the tier:** After classification, briefly tell the user: "Running [tier] research on [topic]..." so they know what to expect.

### Tier Budgets

| Dimension | Quick | Standard | Deep |
|-----------|-------|----------|------|
| Duration | ~2 min | ~6-8 min | ~12-15 min |
| Search workers | 1 (inline) | 2-3 parallel | 4-5 parallel |
| Vault searches | 1-2 | 3-4 | 4-5 |
| Personas | None | 1 skeptic | 3-5 diverse |
| Queries generated | 2-3 | 5-8 | 10-15 |
| Candidate sources | 10-15 | 40-60 | 80-120 |
| Deep reads | 0 (snippets only) | 15-25 | 30-50 |
| Cited in report | 3-8 | 15-20 | 20-30 |
| Follow-up loops | 0 | 1 cycle max | Up to 2 cycles |
| Critique | None | Inline section | Separate worker |
| GitHub discovery | No | Yes | Yes |

## Scratch Workspace

All intermediate files are written to `/workspace/agent/.cache/research/<run-id>/` where `<run-id>` is a short UUID generated at the start of the run. This directory is:
- Created at the start of Phase 0
- Used by all workers for reflections, source tracking, and draft content
- Cleaned up after successful report write (unless `--keep-scratch` is specified)
- Retained on failure for debugging

**Never write scratch files to the vault.** Only the final polished report goes to `/workspace/extra/vault/Sources/Research/`.

To create the workspace at the start of the run:
```bash
RUN_ID=$(python3 -c "import uuid; print(str(uuid.uuid4())[:8])")
SCRATCH="/workspace/agent/.cache/research/$RUN_ID"
mkdir -p "$SCRATCH"
```

## Available Sources

| Source | Good for | Service |
|--------|----------|---------|
| WebSearch (Claude built-in) | Broad web discovery, docs, comparisons | Built-in tool (free) |
| Reddit search | Community opinions, practitioner experiences | reddit-search API (mode: reddit) |
| Reddit post + comments | Deep thread reads, direct quotes | reddit-search API (/api/post) |
| markdown.new + WebFetch | Token-efficient page reading (~80% reduction) | WebFetch with https://markdown.new/ prefix |
| WebFetch (Claude built-in) | JS-rendered pages, fallback for markdown.new | Built-in tool |
| Vault search | Prior research, Reddit saves, terminology | vault-search API (/api/search) |
| GitHub repos/issues | OSS projects, implementations, bugs | gh CLI via Bash |

## Research Phases

### Phase 0: Vault Search (Seed Phase)

Before searching the web, search the local Obsidian vault. The vault contains **5700+ notes** including Reddit saves, prior research reports, and personal notes.

**How to search:**

```bash
curl -s http://host.docker.internal:11236/api/search \
  -H 'Content-Type: application/json' \
  -d '{"query": "topic keywords", "limit": 10}'
```

Run 3-4 varied vault searches:
- Broad hybrid: `{"query": "topic keywords"}`
- Exact keywords: `{"query": "specific term", "mode": "fulltext"}`
- Reddit saves: `{"query": "topic", "filter": {"sub": "selfhosted"}}`
- Prior reports: `{"query": "topic", "filter": {"type": "research"}}`

**Role: Vault is a SEED, not an authority.** Vault results inform query planning. They are not citeable as current truth. The one exception: Reddit saves and personal notes with unique community voice CAN be cited directly, since these are primary sources.

For each vault hit, extract and record:
- Terminology and project names (use in web queries)
- Subreddit names from `sub` field (target in Reddit search)
- Key claims WITH the note's created date (for freshness assessment)
- Community opinions from Reddit saves (these are primary sources)

**Use vault results to shape query planning:**
- If vault has a prior research report on this topic, read it, focus web search on what's changed
- Vault terminology informs query wording for Phase 1
- Subreddits discovered inform Reddit search targeting

**DO NOT cite vault claims as current web truth.** Web search (Phase 2) is the authority for current state. Vault claims are leads to verify.

**Per tier:**

| Tier | Vault searches | Behavior |
|------|---------------|----------|
| Quick | 1-2 | Terminology extraction only |
| Standard | 3-4 | Full seed extraction, prior research check |
| Deep | 4-5 | Full seed + explicitly search for prior reports on this topic |

### Phase 1: Query Planning

Using vault seeds + the user's topic, generate a structured query plan. Each query is tagged with its source and the persona that motivated it.

**Persona-informed planning:**

| Tier | Personas | Queries |
|------|----------|---------|
| Quick | None | 2-3 direct queries |
| Standard | 1 skeptic/devil's advocate | 5-8 queries across web + Reddit |
| Deep | 3-5 diverse personas (e.g., practitioner, security auditor, skeptic, newcomer, adjacent-domain expert) | 10-15 queries |

Personas are used to DIVERSIFY QUERIES, not to spawn separate workers. The planner asks: "What would a security auditor search for? What would a skeptic search for?" and generates queries from those angles.

**Deep tier query coverage must include:** mainstream view, counterarguments, risks, alternatives, recent developments.

WebSearch is the primary source for general web queries. reddit-search is used for Reddit-specific discovery and enrichment.

**Output format** (write to `$SCRATCH/query-plan.md`):

```markdown
# Query Plan
Tier: standard
Topic: [user's topic]
Personas: skeptic

## Queries
- query: "X vs Y performance benchmarks 2026"
  source: websearch
  persona: practitioner

- query: "X problems criticism"
  source: reddit-search
  persona: skeptic

- query: "X best practices configuration"
  source: websearch
  persona: practitioner

- query: "X" (gh search repos, sort by stars)
  source: gh
  persona: practitioner
```

**Source routing:**
- `websearch` → Claude's built-in WebSearch tool (all general web queries)
- `reddit-search` → POST http://host.docker.internal:11237/api/search
- `gh` → `gh search repos/issues` via Bash

### Phase 2: Parallel Search

Fan out to parallel workers via the Task tool.

**Per tier:**

| Tier | Workers | Behavior |
|------|---------|----------|
| Quick | 1 (inline, no Task dispatch) | Execute 2-3 queries sequentially in current session |
| Standard | 2-3 parallel Task workers | Each gets 3-4 queries, runs in parallel |
| Deep | 4-5 parallel Task workers | Each gets 3-4 queries, runs in parallel |

**Dispatching workers:**

Use the Task tool to dispatch parallel workers. Each Task prompt must include the FULL worker instructions below since Task workers do not have named agent types. Group queries by topic angle (not by source type) so each worker covers a coherent research thread.

Each worker's prompt must include:
1. The Worker Instructions Template below (copy verbatim)
2. Its assigned queries from the query plan
3. The vault seed context (terminology, leads, subreddits)
4. Its scratch file path: `$SCRATCH/agent-<n>.md`

**Launch all workers in a single message** using multiple Task tool calls to maximize parallelism.

#### Worker Instructions Template

Include this verbatim in each Task worker prompt:

---

You are a research worker. You execute search queries, read sources, and document findings with full provenance.

**Your Tools:**
- **WebSearch** (Claude built-in) — primary source for general web queries
- **WebFetch with markdown.new** — token-efficient page reading: `WebFetch url="https://markdown.new/<original-url>"`. Falls back to plain WebFetch if markdown.new returns an error.
- **WebFetch** (Claude built-in) — fallback for JS-rendered pages or when markdown.new fails
- **Bash** — for `gh search repos/issues` (GitHub discovery) and `curl` commands
- **vault-search API** — `curl -s http://host.docker.internal:11236/api/search -H 'Content-Type: application/json' -d '{"query": "..."}'`
- **reddit-search API** — `curl -s http://host.docker.internal:11237/api/search -H 'Content-Type: application/json' -d '{"query": "...", "subreddits": [...], "limit": 10}'`
- **reddit-search post API** — `curl -s http://host.docker.internal:11237/api/post -H 'Content-Type: application/json' -d '{"url": "...", "comment_limit": 30, "comment_sort": "best", "comment_depth": 3, "extract_links": true}'`

**Reflection Protocol:**

**Rule: "If you do two searches in a row without writing a reflection, you are violating the protocol."**

After each search call:

1. **Write a reflection** (3-5 sentences) to your scratch file:
   - What was found in this search
   - What's novel compared to previous reflections
   - What's still missing or worth exploring

2. **Append raw source entries** to a `## Sources` section of your scratch file:

```markdown
## S-1
- URL: https://example.com/article
- Title: "Article Title"
- Domain: example.com
- Type: web
- Snippet: First 2-3 sentences of relevant content
- Retrieved: YYYY-MM-DD

## S-2
- URL: https://reddit.com/r/selfhosted/comments/abc123/post_title
- Title: "Post Title"
- Subreddit: r/selfhosted
- Type: reddit
- Score: 142
- Comments: 47
- Snippet: Post summary or key excerpt
- Retrieved: YYYY-MM-DD
```

3. **Only carry reflections forward** as context for the next search. Raw source entries are written to the file but NOT re-read between searches. This saves tokens.

**Scratch File Structure:**

```markdown
# Agent N — [Topic Angle]

## Reflection 1
[3-5 sentences after first search]

## Reflection 2
[3-5 sentences after second search]

---

## Sources

## S-1
- URL: ...
[full provenance]

## S-2
- URL: ...
```

**Deep Reads:**

When instructed to deep-read sources:
- **Web pages:** Use `WebFetch url="https://markdown.new/<url>"` (returns clean markdown, ~80% fewer tokens). If output is empty or <200 chars, fall back to plain `WebFetch url="<url>"`.
- **Reddit posts:** Use reddit-search `POST /api/post` with `comment_limit: 30, comment_sort: "best"`
- **GitHub READMEs:** Use `gh repo view org/repo` via Bash

For Reddit posts, capture direct quotes from top comments (score 10+):
```markdown
> "Direct quote from highly upvoted comment"
> — u/username (31 pts)
```

**Fallback Chain:**

If `curl http://host.docker.internal:11237` fails, use WebSearch (Claude built-in) for all queries.
If markdown.new fails, use plain WebFetch for page reads.
If WebFetch also fails, skip source and note in reflections.

---

### Phase 3: Deep Read

After Phase 2 completes, the orchestrator (main session) selects the top sources for deep reading based on tier budget.

**Quick tier: Skip this phase entirely.** Phase 2 search snippets are sufficient.

**Source selection:** Rank all sources from all worker scratch files by: relevance to the research question, source diversity (don't read 5 pages from the same domain), type diversity (mix of web, Reddit, GitHub). Select top N per tier budget.

**Deep reads use the following tools:**
- **Web pages:** WebFetch with markdown.new proxy: `WebFetch url="https://markdown.new/<original-url>"` as primary. Falls back to plain WebFetch for JS-rendered pages or if markdown.new fails.
- **Reddit posts + comments:** reddit-search API `POST http://host.docker.internal:11237/api/post` with `comment_limit: 30, comment_sort: "best", comment_depth: 3, extract_links: true`
- **GitHub READMEs:** `gh repo view org/repo` via Bash
- **Fallback chain:** markdown.new + WebFetch → plain WebFetch → skip source

**Parallelism:** Dispatch deep reads in batches of 5 via parallel tool calls (simple fetches, not workers).

**Per-source output** (append to `$SCRATCH/source-<n>.md`):

```markdown
## Source: [Title](url)
- Domain: example.com
- Retrieved: 2026-03-26
- Type: web | reddit | github | vault
- Reddit metadata: score: 142, comments: 47, subreddit: r/selfhosted
- Key findings:
  - Finding 1
  - Finding 2
  - Finding 3
- Notable quotes:
  > "Direct quote from the source or highly upvoted comment"
  > — u/username (31 pts)
- Relevance: high | medium
```

**For Reddit posts:** Capture direct quotes from top comments with score 10+ as blockquotes with attribution. Target 3-8 direct quotes per report.

**Volume targets:**

| Tier | Deep reads |
|------|-----------|
| Quick | 0 (skip) |
| Standard | 15-25 |
| Deep | 30-50 |

### Phase 4: Synthesis

**Quick tier:** No separate synthesis phase. Answer directly from Phase 2 search results, writing the report inline. Still follow the output format.

**Standard and Deep tiers:**

**Input:** Read all worker scratch files (reflections first, then source entries) + deep-read outputs from Phase 3.

**Process:**
1. Read all worker reflections first — these are the distilled insights (lightweight context)
2. Identify themes, contradictions, and consensus across all workers
3. Pull in raw source data from scratch files only for claims that need direct evidence or quotes
4. Write the draft report following the output format in `references/output-format.md`
5. Follow Obsidian markdown conventions (wikilinks, footnotes, frontmatter)

**Cross-source convergence:** Claims backed by multiple independent sources across different platforms (web + Reddit + GitHub) are high-confidence. Single-source claims must be noted as such.

**Deep tier addition:** Include an explicit "Contradictions & Open Questions" subsection when sources disagree on a material point.

Write the draft to `$SCRATCH/draft.md`.

## Citation Chain

**Every factual claim in the report MUST have a footnote pointing to a source the research actually read. Never fabricate a citation.**

### Worker Level (Phase 2+3)

Each research worker numbers its sources sequentially (`S-1`, `S-2`, ...) in its scratch file with full provenance: URL, title, domain, type, retrieval date, Reddit/vault metadata, key findings, direct quotes.

Reflections reference these IDs: "S-3 and S-7 agree that X is preferred; S-5 contradicts this."

### Synthesis (Phase 4)

The synthesis step:
1. Collects ALL source entries from ALL scratch files
2. Deduplicates by URL (same URL from different workers = one source)
3. Assigns final footnote numbers:
   - `[^1]`, `[^2]`, `[^3]`, ... for web, Reddit, and GitHub sources
   - `[^v1]`, `[^v2]`, ... for vault sources (Reddit saves and personal notes only)
4. Maps worker source IDs (S-1, S-2) → final footnote numbers
5. Writes the report with Obsidian footnote syntax

### Source Block Format

```markdown
[^1]: [Source Title](https://example.com/article) — *example.com* — Retrieved 2026-03-26
   > Key quote or finding extracted from this source

[^2]: [Reddit: Post Title](https://reddit.com/r/selfhosted/...) — *r/selfhosted* — Retrieved 2026-03-26, Score: 142, Comments: 47
   > Top insight from the thread

[^v1]: ~/vault/Sources/Reddit/selfhosted/saved-post.md — *vault: r/selfhosted* — Saved 2025-08-15
   > Key insight from vault note
```

### Vault Citation Rule

Vault sources are ONLY cited when they are:
- Reddit saves with unique community voice (primary sources)
- Personal notes with original observations

Vault sources are NEVER cited for current factual claims. Web search is the authority for current state.

### Phase 5: Follow-up Loop (Gap Detection)

**Quick tier: Skip entirely.**

After the synthesis draft is written, scan it for gaps:
- Topic areas with fewer than 2 independent sources
- Claims resting on a single source
- Topic areas with no counterargument coverage

**Standard tier (1 cycle max):**
1. Identify 2-4 specific gaps in the draft
2. Generate targeted delta queries for those gaps
3. Execute queries (inline, using WebSearch, reddit-search, and markdown.new + WebFetch)
4. Incorporate new findings into the draft
5. Update source list with new sources

**Deep tier (up to 2 cycles):**
- Cycle 1: Same as standard — fill source gaps
- Cycle 2: Check for unresolved contradictions. If sources disagree on a material point and only one side has evidence, search for the other side.

**Termination:** Stop when:
- All major claims have 2+ independent sources, OR
- Delta queries return no novel information (URLs already in source list), OR
- Cycle budget exhausted

### Phase 6: Critique

**Quick tier: Skip entirely.**

**Standard tier (inline critique):**

Add a "Limitations & Open Questions" section to the end of the report (before Sources). Cover:
- Source bias: are all sources from the same platform or perspective?
- Missing perspectives: what viewpoint is not represented?
- Confidence calibration: which findings are well-supported vs. thinly sourced?
- Temporal gaps: are key claims based on dated sources?

**Deep tier (separate worker critique):**

Dispatch a critique worker via the Task tool. Include the Critic Instructions Template below in the Task prompt. Provide:
- The draft report content from `$SCRATCH/draft.md`
- The original research query
- The critique output path: `$SCRATCH/critique.md`

#### Critic Instructions Template

Include this verbatim in the critique Task prompt:

---

You are a research critic. You evaluate a research report draft as a fresh reader. You have NO access to search tools and NO context beyond what's in the draft and the original query. This constraint is deliberate: you assess the report as a reader would.

**Your Task:** Read the draft report and original research query provided. Write your critique to the scratch file path provided.

**Critique Format:**

```markdown
## Critique
- Overall confidence: high | medium | low
- Gaps identified:
  1. [specific gap, e.g., "no sources address performance under load"]
  2. [specific gap]
- Actionable searches: [0-3 specific queries that would fill gaps, or "none, report is sufficient"]
  - "exact query string" — reason this would fill a specific gap
- Overconfidence flags:
  - [claim that appears strong but rests on a single source or weak evidence]
- Missing perspectives:
  - [viewpoint not represented, e.g., "no security perspective", "no cost analysis"]
```

**Rules:**
- Be specific. "Could be more thorough" is useless. "Section 3 claims X based on one blog post; a benchmark or official docs citation would strengthen this" is useful.
- Only flag actionable searches if you can write the exact query string. Vague suggestions waste time.
- 0 actionable searches is a valid and common outcome.
- Do NOT try to search, browse, or verify claims yourself. You evaluate what's on the page.

---

**If the critique identifies actionable searches (1-3 specific queries):**
1. Execute those queries (using WebSearch, reddit-search, and markdown.new + WebFetch)
2. Deep-read the top results
3. Incorporate findings into the draft
4. Update source list
5. Do NOT re-run critique — one critique pass is sufficient

### Phase 7: Final Write + Cleanup

1. **Finalize the report:**
   - Read `$SCRATCH/draft.md` (with any follow-up loop and critique updates incorporated)
   - Ensure all citations are properly numbered and the Sources section is complete
   - Verify frontmatter fields:
     - `skill: research/6.0.0-container`
     - `model`: the model powering this session
     - `sources_count`: actual count of sources in Sources section
     - `vault_sources_count`: count of `[^vN]` vault sources cited
     - `tools_used`: list of tools that returned results (e.g., `[reddit-search-api, markdown-new, vault-search, websearch, gh-cli]`)
   - Auto-assign 2-5 `tags` from vault tag conventions
   - Follow all Obsidian markdown conventions

2. **Write the final report** to `/workspace/extra/vault/Sources/Research/<Topic>.md`
   - `<Topic>` is a concise, descriptive title derived from the query
   - If file exists, append date: `<Topic> (YYYY-MM-DD).md`

3. **Clean up scratch workspace:**
   ```bash
   rm -rf "$SCRATCH"
   ```
   Skip cleanup if `--keep-scratch` was specified.

4. **Report to user:**
   - File path where the report was saved
   - 2-3 sentence summary of the key finding
   - Source counts: discovered → deep-read → cited
   - Tier used and whether any follow-up loops or critique ran
   - Any gaps or failures encountered

## Error Handling

- **reddit-search API unreachable (host.docker.internal:11237):** Fall back to WebSearch (built-in) for all queries. Reddit-specific discovery unavailable.
- **markdown.new fails:** Fall back to plain WebFetch (Claude built-in). Note slightly higher token usage.
- **vault-search unreachable (host.docker.internal:11236):** Skip vault search. Proceed with web-only research. Note in report.
- **WebSearch fails:** Continue with reddit-search API results only. Note the gap.
- **Reddit auth failure (reddit-search API returns 401):** Skip Reddit sources. Note in report.
- **gh CLI fails:** Skip GitHub discovery. Fall back to WebSearch with site-scoped queries.
- **Deep-read fails on a URL:** Skip that source. Mark as "[content unavailable]" in Sources. Continue with remaining sources.
- **Worker fails or times out:** Read whatever partial scratch file exists. Continue synthesis with available data. Note reduced coverage.
- **All providers fail:** Write a minimal report explaining what was attempted and why it failed.

## After Writing

Tell the user:
- The file path where the report was saved
- A 2-3 sentence summary of the key finding
- How many sources were consulted (discovered vs. deep-read vs. cited)
- The tier used and whether any follow-up loops or critique ran
- Any gaps or failures encountered
