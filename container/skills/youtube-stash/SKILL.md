---
name: youtube-stash
description: >
  Save YouTube videos and transcripts via the youtube-stash API. Use whenever a
  YouTube URL appears in a message (youtube.com, youtu.be, /shorts/, /live/) —
  whether the user asks to save, transcribe, download, or just pastes a URL with
  no instruction. Also use when the user says "get the transcript", "save this
  video", "download audio", or similar without a URL if a YouTube link was
  recently shared.
---

# YouTube Stash

Save YouTube videos, extract transcripts, and download audio via the youtube-stash API at `172.17.0.1:8901`.

## Auth

Auth is handled automatically by the OneCLI proxy. The `HTTP_PROXY` env var routes all HTTP requests through the gateway, which injects the `Authorization: Bearer` header for requests to `172.17.0.1`. **Do not add auth headers manually** — just make the curl calls without `-H "Authorization: ..."` and the proxy handles it.

## When to Act

Any time a YouTube URL appears (youtube.com, youtu.be, /shorts/, /live/):

1. **User says "save", "save it", "stash this", or similar** — POST /add with mode=both
2. **User says "get the transcript", "transcribe this"** — POST /transcript (returns text inline)
3. **User says "download audio", "get the audio"** — POST /add with quality=audio
4. **User says "download" or "get the video"** — POST /add with mode=video
5. **Bare URL with no instruction** — offer options:
   > I can save that. Transcript + video, transcript only, or audio only?
6. **Channel rules specify auto-save** — follow channel rules without asking

Do NOT silently auto-save every YouTube URL. When in doubt, ask.

## API

### Save a video — POST /add

```bash
curl -s -X POST http://172.17.0.1:8901/add \
  -H "Content-Type: application/json" \
  -d '{"url": "URL", "mode": "both", "quality": "best"}'
```

Modes and quality:
- `mode`: `transcript` | `video` | `both` (default: `both`)
- `quality`: `best` | `1080p` | `720p` | `audio`
  - `audio` — AAC M4A with chapter splitting; auto-promotes mode to `video`

Returns immediately: `{"status": "queued", "video_id": "...", "mode": "..."}`

### Check status — GET /status/{video_id}

```bash
curl -s http://172.17.0.1:8901/status/VIDEO_ID
```

Returns: `transcript_status` (tier1/tier2/tier3/failed), `video_status` (downloaded/failed/skipped), `title`, `channel`, paths.

### Get transcript inline — POST /transcript

Fast path for when you need the actual text:

```bash
curl -s -X POST http://172.17.0.1:8901/transcript \
  -H "Content-Type: application/json" \
  -d '{"url": "URL"}'
```

Returns `200` with `transcript_text` if T1 (captions) succeeds, or `202` with a `job_id` to poll at `/transcript/{job_id}`.

### Health — GET /health (no auth)

```bash
curl -s http://172.17.0.1:8901/health
```

## Behavior

**For save/download requests (POST /add):**
1. Submit, confirm: "Queued VIDEO_ID — transcript + video"
2. Don't background-poll. Check GET /status/{video_id} when the user asks
3. Keep it short: "Done — tier1 transcript, 234MB video downloaded"

**For transcript requests (POST /transcript):**
1. Call POST /transcript — if 200, display the transcript text directly
2. If 202 (async fallback), tell the user it's processing and poll /transcript/{job_id}
3. Once complete, display the transcript or summarize if the user asked for a summary

If /health returns an error or is unreachable, tell the user the service is down and stop. Don't retry aggressively.

## Error Handling

| Issue | Response |
|-------|----------|
| /health unreachable | "youtube-stash is down" — stop |
| 401 Unauthorized | OneCLI credential missing or wrong — tell user to check OneCLI vault |
| rate_limited | YouTube IP blocked — tell user, don't retry |
| Transcript failed | Report which tier failed, video may still succeed |
