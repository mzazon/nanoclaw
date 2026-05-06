---
name: vault-search
description: Search and query local Obsidian vault using hybrid search (BM25 + fuzzy + semantic). CLI-first with API fallback.
---

# vault-search

Hybrid search engine for Obsidian vaults. Combines BM25 fulltext, fuzzy title matching, and vector semantic search with Reciprocal Rank Fusion. CLI auto-detects a running service and routes through API; falls back to direct DB access.

## Quick Start

```bash
# Search the vault (auto-detects API or direct mode)
vs search "kubernetes networking" --json

# Semantic search
vs search "container orchestration strategy" --mode semantic --json

# Search with filters
vs search "migration" --scope "Projects/" --tag infra --json

# Read a note
vs read "Projects/2026-03-15 Cluster Migration.md" --json

# Read raw content (no headers, metadata, or formatting — ideal for LLM context)
vs read "Projects/2026-03-15 Cluster Migration.md" --raw
```

## Search Modes

| Mode | Flag | Description |
|------|------|-------------|
| hybrid (default) | `--mode hybrid` | BM25 + fuzzy title + semantic, merged via RRF |
| fulltext | `--mode fulltext` | BM25 keyword search with porter stemmer |
| semantic | `--mode semantic` | Vector similarity via nomic-embed-text embeddings |
| title | `--mode title` | Fuzzy title + alias matching |

## Filtering

All filters use **soft-boost** by default: matching docs get a score boost, but non-matching docs still appear. Add `--strict` for hard exclusion.

```bash
# Folder scope
vs search "query" --scope "Projects/"
vs search "query" --scope "Tasks/" --scope "Projects/"

# Tags (from frontmatter tags array)
vs search "query" --tag infra
vs search "query" --tag networking --tag vpc

# Frontmatter fields
vs search "query" --filter "type=meeting"
vs search "query" --filter "status=open"
vs search "query" --filter "project=atlas"
vs search "query" --filter "context=work"

# Date range
vs search "query" --after 2026-01-01 --before 2026-04-01

# Combined filters
vs search "migration" --scope "Projects/" --filter "project=atlas" --tag infra --after 2026-01-01

# Strict mode (hard exclusion)
vs search "query" --scope "Tasks/" --filter "status=open" --strict
```

### Available Filter Fields

`sub`, `type`, `category`, `status`, `session_id`, `project`, `tool`, `score`, `context`, `customer`

### Deep Frontmatter Filtering

Filter fields support dotted paths for nested YAML. If a frontmatter field contains a nested object, it is automatically flattened:

```yaml
# Frontmatter: metadata: { author: "alice", year: 2026 }
# Indexed as: metadata.author = "alice", metadata.year = "2026"
vs search "query" --filter "metadata.author=alice"
```

### Filtering Note

All filter types (`--scope`, `--tag`, `--filter`) work with `--strict` in all modes including hybrid. Post-fusion filtering ensures strict results are enforced across BM25, semantic, and fuzzy pipelines.

## Write Operations

```bash
# Reindex a specific file (after creating/editing a vault note)
vs reindex "Notes/2026-04-05 New Note.md"

# Reindex + embed in one step
vs reindex "Notes/2026-04-05 New Note.md" --embed

# Embed all pending (unembedded) chunks
vs embed

# Embed a specific file (reindexes first)
vs embed "Notes/2026-04-05 New Note.md"

# Embed in background (non-blocking, API mode)
vs embed --async

# Full vault reindex (re-scans all files, preserves embeddings)
vs reindex
vs reindex --force

# Full vault reindex + embed
vs reindex --force --embed

# DESTRUCTIVE: wipe database and rebuild (requires confirmation)
vs reindex --wipe --yes
```

### Safety Notes

- `--force` re-indexes all files even if unchanged but **preserves embeddings**
- `--wipe` **DELETES the entire database** including all embeddings — requires `--yes` or interactive confirmation
- `vs embed` only processes pending chunks — never touches existing embeddings
- Model mismatches are detected automatically and embedding is blocked until resolved

## Index Health

```bash
# Check status (shows warnings for pending/failed chunks and model mismatches)
vs status
vs status --json

# Embedding progress
vs embeddings status

# Retry failed embeddings
vs embeddings retry
```

## MCP Server

```bash
# Start MCP stdio transport — auto-bridges through running service if detected
vs mcp

# Force full lifecycle (skip API bridge detection)
vs mcp --full

# HTTP/SSE mode (for systemd/Docker)
vs serve --port 11236
```

When a systemd service is already running, `vs mcp` automatically operates in **bridge mode** — proxying MCP tool calls through the HTTP API. No lockfile, no DB access, multiple instances safe. This enables multi-agent scenarios where several Claude Code sessions load MCP simultaneously.

## Output

| Flag | Format | Use case |
|------|--------|----------|
| (default) | Human-readable table | Interactive use |
| `--json` | Structured JSON | Programmatic/agent use |
| `--raw` | Raw content (read only) | LLM context injection |
| `--verbose` | INFO/DEBUG to stderr | Diagnostics |

### JSON Output Schema

```json
{
  "results": [
    {
      "path": "Projects/2026-03-15 Cluster Migration.md",
      "title": "Cluster Migration",
      "score": 0.85,
      "snippet": "Discussed migration timeline...",
      "tags": ["infra", "iam"],
      "matchedBy": ["bm25", "semantic"],
      "metadata": {"type": "meeting", "project": "atlas"}
    }
  ],
  "meta": {
    "query": "cluster migration",
    "mode": "hybrid",
    "count": 5,
    "latency_ms": 72,
    "backend": "api"
  }
}
```

### Exit Codes

| Code | Meaning |
|------|---------|
| 0 | Success |
| 1 | General error |
| 2 | Service required but not running (`--api` mode) |
| 3 | Lockfile contention (another writer active) |

## Other Useful Flags

```bash
# Limit results
vs search "query" --limit 20

# Minimum score threshold
vs search "query" --threshold 0.3

# Similarity search (find notes similar to a given note)
vs search --path "Projects/2026-03-15 Cluster Migration.md"

# Graph traversal (linked notes)
vs search --path "People/Alice Example.md" --related --depth 2

# Re-rank with cross-encoder (slower, more precise)
vs search "query" --rerank

# Multiple queries (fan-out, merged via RRF)
vs search "docker" "container" "kubernetes"
```

## Troubleshooting / API Fallback

```bash
# Check if service is running
curl -s http://localhost:11236/healthz
# Returns "ok" if running

# Check service logs
journalctl --user -u vault-search --since "5 minutes ago" --no-pager

# Check embedding health (model mismatch, pending/failed counts)
curl -s http://localhost:11236/api/embeddings/status | python3 -m json.tool

# Force direct DB mode (bypass API)
vs search "query" --direct --json

# Force API mode (fail fast if service is down)
vs search "query" --api --json

# Direct API calls (if CLI is misbehaving)
curl -s -X POST http://localhost:11236/api/search \
  -H 'Content-Type: application/json' \
  -d '{"query": "cluster migration", "mode": "hybrid", "limit": 10}'

curl -s -X POST http://localhost:11236/api/reindex \
  -H 'Content-Type: application/json' \
  -d '{"path": "Notes/2026-04-05 New Note.md"}'

curl -s -X POST http://localhost:11236/api/embed \
  -H 'Content-Type: application/json' \
  -d '{"async": true}'
```

### Non-Interactive SSH PATH

`vs` is at `~/.local/bin/vs` — NOT in non-interactive SSH PATH. Always use the full path:

```bash
ssh intel-pc "/home/mzazon/.local/bin/vs search 'query' --json"
```

### HTTP API Body Schema

For direct API use (e.g. from inside a container where the CLI isn't available):

**POST /api/search**
```json
{
  "query": "your query",
  "mode": "hybrid",
  "limit": 10,
  "scope": ["Tasks/", "Projects/"],
  "filters": {"context": "personal", "status": "open"},
  "strict": true,
  "threshold": 0.3
}
```
- `scope`: array of folder prefixes (not repeated `--scope` flag strings)
- `filters`: object of frontmatter key-value pairs (not repeated `--filter` flags)
- `strict`: boolean — **note:** HTTP API `strict` is less reliable than CLI `--strict` for hard frontmatter filtering. For queries where only matching docs should appear (e.g. status=open tasks), prefer the CLI via SSH.

**POST /api/read**
```json
{"paths": ["Tasks/2026-05-01 My Task.md", "Projects/Fusion/Fusion.md"]}
```
- `paths`: **array** (not `"path"` singular) — takes a list, returns content for each

## Configuration

Config file: `~/.vault-search/config.json`

```bash
# View effective config
vs config

# Service management
systemctl --user start vault-search
systemctl --user stop vault-search
systemctl --user status vault-search
systemctl --user restart vault-search
```
