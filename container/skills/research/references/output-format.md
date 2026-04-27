# Research Report Output Format

## Frontmatter

Every research report uses this exact frontmatter schema, which extends the Obsidian vault's universal schema with research-specific fields:

```yaml
---
type: research
context: personal
created: YYYY-MM-DD
modified: YYYY-MM-DD
ai: true
tags: []
query: "the original research topic or question"
model: claude-sonnet-4-5
skill: research/5.2.0
sources_count: 25
vault_sources_count: 3
tools_used: [web-search-api, crawl4ai, vault-search, websearch, gh-cli]
---
```

### Field Definitions

| Field | Required | Description |
|-------|----------|-------------|
| `type` | yes | Always `research` |
| `context` | yes | Always `personal` (homelab research) |
| `created` | yes | Today's date, YYYY-MM-DD |
| `modified` | yes | Same as created (updated on re-research) |
| `ai` | yes | Always `true` — AI-generated content |
| `tags` | yes | 2-5 tags from vault master tag list, or `[]` |
| `query` | yes | The original research topic verbatim |
| `model` | yes | Model ID that produced this report |
| `skill` | yes | `research/<version>` for provenance lineage |
| `sources_count` | yes | Count of sources in the Sources section |
| `vault_sources_count` | yes | Count of vault sources cited (0 if none) |
| `tools_used` | yes | List of MCP tools that returned results |

## Report Structure

```markdown
# <Topic Title>

## Executive Summary

3-5 sentences: what was researched, key finding, recommendation.

## Key Findings

### <Finding 1 Title>

Detail with inline citations [^1] [^3].

### <Finding 2 Title>

Detail with inline citations [^2] [^5].

(As many findings as warranted by the research)

## Analysis

Deeper discussion, trade-offs, comparisons. This section is optional for simple topics.

## Recommendations

1. First recommendation with rationale
2. Second recommendation
3. ...

## Sources

[^1]: [Source Title](https://example.com/article) — *example.com* — Retrieved YYYY-MM-DD
   > Key quote or finding extracted from this source

[^2]: [Reddit: Post Title](https://reddit.com/r/selfhosted/...) — *r/selfhosted* — Retrieved YYYY-MM-DD, Score: 142, Comments: 47
   > Top insight from the thread

[^3]: [Documentation Title](https://docs.example.com/...) — *docs.example.com* — Retrieved YYYY-MM-DD
   > Relevant excerpt
```

## Source Citation Rules

- Use Obsidian footnote syntax: `[^1]`, `[^3]` for web sources (NOT `[1]` — bare brackets render as broken wikilinks in Obsidian)
- Use `[^v1]`, `[^v2]` for vault sources, with vault-relative paths:
  ```
  [^v1]: ~/vault/Sources/Reddit/selfhosted/linkwarden-v212.md — *vault: r/selfhosted* — Saved 2025-08-15
     > Key insight from vault note
  ```
- Web sources are numbered sequentially starting at 1; vault sources use `v` prefix
- Reddit sources include score and comment count
- All sources include retrieval date
- Each source has a blockquote with the key finding from that source
- Include 3-8 direct quotes from highly upvoted Reddit comments (10+ score) with attribution:
  ```
  > "The actual insight from the community"
  > — u/username (score pts)
  ```
- If a source was unavailable for deep-read, note: `[content unavailable — summary only]`

## Filename Convention

- Save to: `~/vault/Sources/Research/<Topic>.md`
- `<Topic>` is a concise title derived from the query (not the query itself if it's a question)
- No date prefix — `created` frontmatter handles dating
- If file exists, append date: `<Topic> (YYYY-MM-DD).md`
