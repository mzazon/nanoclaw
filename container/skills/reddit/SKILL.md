---
name: reddit
description: >
  Quick Reddit search during work sessions. Use when the user says "/reddit",
  "search reddit for", "what does reddit say about", or wants community opinions
  on a topic without running a full research report. Returns ranked posts inline.
metadata:
  author: mzazon
  version: "1.0.0"
disable-model-invocation: true
allowed-tools: Bash
---

# Reddit Search

Quick inline Reddit search via the reddit-search API at `172.17.0.1:11237` (Docker bridge — use this address from inside the container).

## Usage

`/reddit <query>` — search all of Reddit
`/reddit <query> --sub selfhosted,homelab` — scope to subreddits
`/reddit <query> --time week` — recent posts only

## Procedure

1. **Parse the query.** Extract topic and any flags:
   - `--sub <subs>` or "in r/name" → subreddits filter (comma-separated)
   - `--time <range>` → hour, day, week, month, year, all (default: all)
   - `--sort <mode>` → relevance, hot, top, new, comments (default: relevance)
   - `--limit <n>` → number of results (default: 10)

2. **Search.** Call the reddit-search API:

```bash
curl -s http://172.17.0.1:11237/api/search \
  -H 'Content-Type: application/json' \
  -d '{"query": "QUERY", "subreddits": ["SUB1"], "time": "TIME", "sort": "SORT", "limit": LIMIT}'
```

3. **Display results.** Format as a scannable table:

```
Found N results for "query":

| Score | Title | Subreddit | Comments | Relevance |
|-------|-------|-----------|----------|-----------|
| 142 | Post title... | r/selfhosted | 47 | 0.87 |
```

For each result include:
- Reddit score (upvotes)
- Title (truncated to ~60 chars) linked to permalink
- Subreddit
- Comment count
- Relevance score from ranker

4. **Offer follow-up.** After showing results, mention:
   - "Want me to read any of these posts? Give me the number."
   - If user picks a post, fetch it with: `curl -s http://172.17.0.1:11237/api/post -H 'Content-Type: application/json' -d '{"post_id": "ID", "comment_limit": 20}'`

## Error Handling

- If reddit-search API is unreachable: tell the user and suggest `docker ps | grep reddit-search`
- If no results: suggest broader query or different subreddits
