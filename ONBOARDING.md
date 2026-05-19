# Thumbnail Board — Project Onboarding

## What is this?
A YouTube thumbnail reference board for @therealseniordev / @theSeniorDevPodcast.
- **Public board**: https://andreinedelcu.github.io/thumbnail-board/
- **Local server**: http://localhost:3000 (must be running for all write operations)
- **Eagle folder**: "Thumbnail-Examples-Claude" (ID: `MPBRJ4DRT0IR0`) — NEVER touch other Eagle folders

## Architecture
```
Eagle app (localhost:41595 REST, localhost:41596 MCP)
    ↕ proxied by
server.py (localhost:3000)
    ↕
index.html      — main board (grid + lightbox + filters)
tagger.html     — tag items one by one
extension/      — Chrome/Arc extension to save from YouTube
    ↕ git push
GitHub Pages    — public read-only view of data.json
```

## Key files
| File | Purpose |
|------|---------|
| `server.py` | Python HTTP server, Eagle proxy, git auto-publish |
| `data.json` | Source of truth for all videos + tags |
| `index.html` | Public board UI |
| `tagger.html` | Tagger UI |
| `extension/manifest.json` | Chrome MV3 extension |
| `extension/content.js` | YouTube page injection |
| `extension/background.js` | SPA navigation via messaging |

## Starting the server
```bash
cd /Users/andrei/thumbnail-board
python3 server.py
```
Or double-click `tagger.command`.

## Eagle API
- REST GET: `http://localhost:41595/api/...` — CORS open
- REST POST: blocked cross-origin → always proxy through server.py
- MCP: `http://localhost:41596` — gets ALL 2000+ items (REST caps at ~582)
- Eagle folder ID to use: `MPBRJ4DRT0IR0`

## Server endpoints
| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/data` | GET | All videos from data.json |
| `/api/add` | POST | Add video from extension → Eagle + data.json + auto git push |
| `/api/delete` | POST | Delete video by `id` |
| `/api/eagle/update` | POST | Update tags → Eagle + data.json + auto git push |
| `/api/eagle/all-items` | GET | All Eagle items via MCP |
| `/api/publish` | POST | Manual git add + commit + push |
| `/api/sync` | GET | Sync Eagle → data.json |

## data.json schema
```json
{ "id": "YouTube video ID", "title": "...", "channel": "...", "views": "1.2M",
  "tags": ["style-colorful", "mood-happy"], "eid": "Eagle item ID" }
```

## Tag categories
STYLE, MOOD, TEXT, ELEMENT, CAMERA, SUBJECT, FORMATION, TOPIC, CALLOUT, BACKDROP, CHANNEL
- Format: `category-subtag` (e.g. `style-colorful`, `channel-theseniordev-main`)
- Official tags = any tag in the CATS config (used to determine "tagged" status)

## Extension (Chrome/Arc)
- Injects "Save to Board" button on YouTube watch pages
- Sends `{id, title, channel, views, tags}` to `POST /api/add`
- background.js sends `TB_URL_CHANGED` message on SPA navigation (no re-injection)
- getVideoId() reads from: ytd-watch-flexy[video-id] → location.href → document.URL → canonical → og:url → stored currentVideoId
- Views read from embedded `<script>` tags containing `"viewCount"` JSON

## GitHub Pages auto-publish
Every `/api/add` and `/api/eagle/update` calls `auto_publish()` in a background thread:
```
git add data.json → git commit → git push
```
~30 seconds to appear on GitHub Pages.

## Key design decisions
- **data.json = source of truth** for tags (not Eagle MCP, which has stale cache)
- **Eagle MCP** used for fetching all items (REST API caps at ~582)
- **Cross-origin POST** to Eagle blocked → all writes proxied through server.py
- **Delete** only works from localhost (GitHub Pages is static)
- **sync.py is DISABLED** (renamed sync.py.disabled) — do not re-enable, it overwrote data.json

## YouTube channels imported
- `@therealseniordev` → tag: `channel-theseniordev-main`
- `@theSeniorDevPodcast` → tag: `channel-theseniordev-podcast`

## Common issues & fixes
| Problem | Solution |
|---------|----------|
| Extension "no video ID" | Reload extension + Cmd+R on YouTube page |
| Tags not persisting | Server creates data.json entry on first save; reload tagger |
| Delete "not found" | Treated as success (stale cache) |
| GitHub Pages not updating | data.json auto-pushed on every save; wait ~30s |
| Eagle tags stale | data.json overrides Eagle tags in tagger loadItems() |
