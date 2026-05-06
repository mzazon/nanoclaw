---
name: reddit-search
description: Reddit search API with multi-source discovery and BM25 ranking
---

# Reddit Search API

Base URL: `http://172.17.0.1:11237`

All endpoints accept JSON POST. Use curl from Bash tool.

## Quick Start

```bash
# Search Reddit
curl -s http://172.17.0.1:11237/api/search -H 'Content-Type: application/json' \
  -d '{"query":"best DNS ad blocker","subreddits":["selfhosted","homelab"],"limit":10}' | head -c 4000
```

---

## POST /api/search — Reddit Search

Discovers Reddit posts via Tavily + Jina (scoped to `reddit.com`), bulk-fetches structured post data from the Reddit API, then ranks by keyword relevance, recency, engagement, and source quality.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `query` | string | (required) | Search terms |
| `limit` | number | 25 | 1-100 results |
| `subreddits` | string[] | [] | Scope to specific subreddits |
| `sort` | string | `"relevance"` | `relevance`, `hot`, `top`, `new`, `comments` |
| `time` | string | `"all"` | `hour`, `day`, `week`, `month`, `year`, `all` |
| `weights` | object | config | Override ranking weights per-call (see Ranking) |
| `author` | string | -- | Filter by Reddit author |
| `flair` | string | -- | Filter by post flair |

```bash
curl -s http://172.17.0.1:11237/api/search -H 'Content-Type: application/json' \
  -d '{"query":"WireGuard vs OpenVPN speed","subreddits":["WireGuard","OpenVPN"],"limit":10}'
```

**Response:**
```json
{
  "results": [
    {
      "id": "abc123", "title": "...", "author": "...", "subreddit": "WireGuard",
      "score": 42, "upvote_ratio": 0.95, "num_comments": 15, "created_utc": 1772808381,
      "url": "...", "permalink": "https://reddit.com/r/...",
      "is_text_post": true, "content": "...(first 500 chars)...",
      "link_flair_text": "Discussion",
      "relevance_score": 0.87, "source": "web_search"
    }
  ],
  "search_metadata": {
    "query": "WireGuard vs OpenVPN speed",
    "mode": "reddit",
    "sources_used": ["web_search", "reddit_api"],
    "total_found": 23, "returned": 10, "filtered_below_threshold": 3,
    "weights_used": { "keyword": 0.5, "recency": 0.2, "engagement": 0.15, "source": 0.15 }
  }
}
```

---

## POST /api/browse — Browse Subreddit

```bash
curl -s http://172.17.0.1:11237/api/browse -H 'Content-Type: application/json' \
  -d '{"subreddit":"homelab","sort":"hot","limit":10}' | head -c 4000
```

Parameters: `subreddit` (required), `sort` (hot|new|top|rising|controversial), `time`, `limit`, `include_nsfw`.

## POST /api/post — Post Details + Comments

```bash
curl -s http://172.17.0.1:11237/api/post -H 'Content-Type: application/json' \
  -d '{"post_id":"1abc2d3","comment_limit":20}' | head -c 4000
```

Parameters: `post_id` or `url` (one required), `subreddit` (optional, saves an API call), `comment_limit`, `comment_sort` (best|top|new|controversial|qa), `comment_depth`, `extract_links`, `max_top_comments`.

## POST /api/user — User Analysis

```bash
curl -s http://172.17.0.1:11237/api/user -H 'Content-Type: application/json' \
  -d '{"username":"spez","posts_limit":10}' | head -c 4000
```

Parameters: `username` (required), `posts_limit`, `comments_limit`, `time_range` (day|week|month|year|all).

## GET /healthz

Returns `ok`. Used by Docker healthcheck.

## GET /status

Returns JSON: server version, auth mode, rate limit stats, cache stats.

```bash
curl -s http://172.17.0.1:11237/status
```

---

## Ranking Algorithm

Composite score per result:

```
score = (keyword x w_keyword) + (recency x w_recency) + (engagement x w_engagement) + (source x w_source)
```

| Signal | How it's computed | Default weight |
|--------|-------------------|----------------|
| keyword | BM25-lite: term frequency in title (2x) + content. Phrase match bonus. | 0.50 |
| recency | Exponential decay: `0.5^(age_days / half_life)`. Half-life default: 180 days. | 0.20 |
| engagement | `log10(comments + 1) x upvote_ratio / 3` | 0.15 |
| source | Web search sources: 1.0. Reddit API only: 0.5. Both: 1.0. | 0.15 |

Results below `minRelevance` threshold (default 0.1) are filtered out.

**Override weights per-call:**
```json
{"query": "...", "weights": {"keyword": 0.8, "recency": 0.1, "engagement": 0.05, "source": 0.05}}
```

---

## Source Configuration

Discovery sources (Tavily + Jina) run in parallel and fail gracefully -- if one times out or errors, the other continues.

| Source | Env Var | Scoping |
|--------|---------|---------|
| `tavily` | `TAVILY_API_KEY` | `include_domains: ["reddit.com"]` |
| `jina` | `JINA_API_KEY` | `?site=reddit.com` param |

---

## Advanced Usage

```bash
# Community opinions with recency bias
curl -s http://172.17.0.1:11237/api/search -H 'Content-Type: application/json' \
  -d '{"query":"Claude vs GPT real world usage","subreddits":["ClaudeAI","ChatGPT","LocalLLaMA"],"limit":15,"weights":{"recency":0.5,"keyword":0.3}}'

# Time-scoped search
curl -s http://172.17.0.1:11237/api/search -H 'Content-Type: application/json' \
  -d '{"query":"home assistant 2026","time":"month","limit":10}'
```

---

## MCP Transport (backward compatibility)

For MCP clients that need tool discovery:

| Transport | Endpoint |
|-----------|----------|
| SSE | `GET /sse` + `POST /message?sessionId=...` |
| Streamable HTTP | `POST /mcp` |
| stdio | `reddit-search mcp` (CLI) |

MCP tool name: `search_reddit`. Accepts same parameters as `/api/search`.
