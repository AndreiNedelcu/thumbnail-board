# Thumbnail Board — Project Onboarding

A YouTube thumbnail reference board for **@therealseniordev** and **@theSeniorDevPodcast**, plus curated picks from the wider tech / dev / design space.

- **Public board**: https://andreinedelcu.github.io/thumbnail-board/
- **Worker (API)**: https://thumbnail-board-api.andrei-nndd.workers.dev
- **GitHub repo**: https://github.com/AndreiNedelcu/thumbnail-board
- **Items in board**: ~1.7k (and growing via auto-tagging)

## Current architecture (cloud-first)

```
              browser
                 │
        ┌────────┴────────┐
        │                 │
   GitHub Pages       Cloudflare Worker
   (read data.json)   (writes via GitHub API)
                          │
                          ▼
                  data.json on GitHub  ──►  GitHub Pages rebuild
```

There is **no** running local server. Everything goes through the Worker. The user's Mac is only needed for:
- Running `auto_tag.py` (uses local Ollama for vision inference)
- Running `backfill_views.py` / `scrape_youtube.py` (uses local `yt-dlp`)

Eagle is **decommissioned for the production flow**. The user's library still exists locally as a backup, but nothing reads from or writes to it anymore.

## Auth

The Worker is publicly readable (`GET /api/data`) but every write endpoint requires the header `X-Auth-Token`. The token is a single shared secret.

- Token (the user's): `91q9YY3Eqgp5xwbA9dlGZWeGjYOLr6FQXDRdSqpr1eo=`
- Stored in the user's browser via `localStorage` (key: `tb-auth-token`)
- Stored in the Chrome extension via `chrome.storage.local` (key: `tbAuthToken`)
- Stored in the Worker via `wrangler secret` (`AUTH_TOKEN`)
- The `GITHUB_TOKEN` secret on the Worker is a fine-grained PAT with Contents:write on the repo

## Key files

### Frontend (served by GitHub Pages)
| File | Purpose |
|------|---------|
| `index.html` | Public board UI — grid, lightbox, sort, search, Edit Tags inline panel |
| `tagger.html` | One-by-one tag editor. Reads data.json directly. Still used for single-item flows but Edit Tags inside the lightbox covers most cases |
| `api-client.js` | Shared API client. Detects localhost vs cloud, adds `X-Auth-Token`, shows themed login overlay on first write |
| `review.html` | Local-only UI served by `review.py` to approve/reject AI suggestions |
| `curate.html` | Local-only UI served by `curate.py` to curate scraped YouTube candidates |

### Worker (Cloudflare)
| File | Purpose |
|------|---------|
| `worker/index.js` | The whole API; mutates data.json via the GitHub Contents API |
| `worker/wrangler.toml` | Deploy config; secrets are set via `wrangler secret put NAME` |

### Local scripts (Python)
| File | Purpose |
|------|---------|
| `auto_tag.py` | Reads `eagle-pending.json`, calls local Ollama (qwen2.5vl:7b), writes to `pending_review.json` OR auto-publishes via Worker depending on flags. **Currently runs in background** |
| `review.py` + `review.html` | Browser UI to manually approve/edit/reject AI suggestions; writes feedback to `auto_tag_feedback.json` so the next batch learns |
| `run_all.sh` | Wrapper to run `auto_tag.py --batch 0 --auto-approve` in nohup background |
| `scrape_youtube.py` | Uses yt-dlp (no API key) to fetch candidates from channels + queries defined in `scrape_config.json`. Output: `youtube_candidates.json` |
| `curate.py` + `curate.html` | Browser UI grid to keep/reject scraped candidates. Approved ones go into `eagle-pending.json` so auto_tag picks them up |
| `backfill_views.py` | One-time fix-up for items with empty/broken views. Calls yt-dlp per video, batches updates via `/api/update-batch` |

### Chrome / Arc extension
| File | Purpose |
|------|---------|
| `extension/manifest.json` | MV3 manifest. `host_permissions` include youtube.com, the Worker URL, and `localhost:11434` (Ollama) |
| `extension/content.js` | Injects a single round button into YouTube's `.ytInlinePlayerControlsTopRightControls` stack (next to mute/captions). Hover opens a menu with Save / Download / Open / Remove. Single-click→Save runs: extract metadata → Ollama (hqdefault 480×360) → POST to Worker |
| `extension/background.js` | Listens for YouTube SPA URL changes and pings the content script |
| `extension/content.css` | Native YT-style dark round button + dropdown menu |

### Data files (gitignored unless noted)
| File | Purpose | Committed? |
|------|---------|------------|
| `data.json` | Source of truth — every item the board knows about | YES |
| `eagle-pending.json` | Queue of items waiting for auto_tag.py to process | YES (was the Eagle snapshot) |
| `pending_review.json` | AI suggestions waiting for human review | gitignored |
| `pending_rejected.json` | Rejected AI suggestions kept for analysis | gitignored |
| `auto_tag_feedback.json` | "AI said X, user kept Y" — fed back into next batch | gitignored |
| `auto_tag_skip.json` | Video IDs auto_tag couldn't process (private, deleted) | gitignored |
| `auto_published_log.json` | Audit log of items auto_tag.py published | gitignored |
| `youtube_candidates.json` | Output of scrape_youtube.py awaiting curate.py | gitignored |
| `youtube_discarded.json` | Items rejected during curation | gitignored |
| `eagle-no-youtube.json` | Eagle items whose URL we couldn't parse | gitignored (snapshot, kept for reference) |

## Worker endpoints

All POST endpoints require `X-Auth-Token`.

| Endpoint | Method | Body | Purpose |
|----------|--------|------|---------|
| `/api/health` | GET | – | Returns `{ok: true}` |
| `/api/data` | GET | – | Proxies the full data.json (CORS open, no auth) |
| `/api/add` | POST | `{id, title, channel, views, tags, eid?}` | Add one item; rejects if already present |
| `/api/add-batch` | POST | `{items: [...]}` | Add many items in ONE git commit |
| `/api/delete` | POST | `{id}` | Remove one item |
| `/api/bulk-delete` | POST | `{ids: [...]}` | Remove many in ONE commit |
| `/api/update` | POST | `{vid, id?, tags?, views?, title?, channel?, eid?}` | Update an existing item; creates one if vid is unknown |
| `/api/update-batch` | POST | `{items: [{vid, ...}]}` | Update many in ONE commit (used by backfill) |
| `/api/eagle/update` | POST | (alias of `/api/update`) | Legacy alias kept so old callers still work |

The Worker uses the GitHub Contents API (`GET /contents/data.json` → modify → `PUT /contents/data.json`) for every write. It retries up to 3 times on sha conflicts.

## data.json schema

```json
{
  "id": "11-char YouTube video ID",
  "title": "Video title",
  "channel": "Channel name (display, not @handle)",
  "views": "1.2M" | "847K" | "1234" | "",
  "tags": ["style-colorful", "mood-happy", ...],
  "eid": "Eagle item ID (legacy, may be empty)"
}
```

## Tag taxonomy

Tags are `category-subtag`. The canonical category prefixes (Worker accepts these only):
`style`, `mood`, `text`, `element`, `camera`, `subject`, `formation`, `topic`, `callout`, `backdrop`, `channel`.

Within each category the subtag is freeform — custom tags like `style-watercolor` work. The Worker validates only the prefix. The board's UI auto-discovers custom subtags from data.json on each load.

Special: `channel-theseniordev-main` and `channel-theseniordev-podcast` mark items from the user's own channels.

## State persistence on the board

- **localStorage `tb-board-state`**: current sort (default/recent/views/shuffle), search query, scroll Y
- **URL hash `#v=videoId`**: which thumbnail (if any) the lightbox is showing — survives reload

## Auto-tag flow (incremental learning)

```
eagle-pending.json (queue)
        │
        ▼
auto_tag.py  ──►  Ollama qwen2.5vl:7b (local GPU)
        │           uses few-shot from auto_tag_feedback.json
        │           sends the hqdefault thumbnail (480×360)
        ▼
   either pending_review.json (default)
   or directly /api/add via Worker (--auto-approve flag)
        │                                │
        ▼                                ▼
   review.py UI                    GitHub Pages updates
   user approves/edits
        │
        ▼
   auto_tag_feedback.json  ──►  next batch's prompt
```

Three escalation tiers, documented in `AUTO_TAG.md`:
1. **Review every batch** (`auto_tag.py` default)
2. **--auto-approve** with sanity filter (3-10 tags, has style-*)
3. **`./run_all.sh`** background run with `--strict` filter

## Critical rules

- **Eagle folder MPBRJ4DRT0IR0** (Thumbnail-Examples-Claude) is the only Eagle scope. NEVER touch other folders.
- **`sync.py.disabled` is disabled for a reason** — it once overwrote data.json with stale data. Do not re-enable.
- **`auto_tag.py` is running in background right now** when working on the project. Do not kill it unless asked.
- **Never commit the AUTH_TOKEN to git** — it lives only in `wrangler secret`, `localStorage`, and `chrome.storage`.
- **Worker writes are batched** (`/api/add-batch`, `/api/update-batch`) because GitHub Pages rate-limits builds. Don't write code that calls `/api/add` in a tight loop.

## Running the worker

```bash
cd worker
wrangler deploy        # ships index.js to Cloudflare
wrangler secret put GITHUB_TOKEN     # set if missing
wrangler secret put AUTH_TOKEN       # set if missing
```

## Running the auto-tag pipeline

```bash
export TB_AUTH_TOKEN='91q9YY3Eqgp5xwbA9dlGZWeGjYOLr6FQXDRdSqpr1eo='

# Tier 1: review every batch
python3 auto_tag.py                  # process 10 items
python3 review.py                    # opens :8765/review.html

# Tier 2: auto-approve confident ones
python3 auto_tag.py --batch 50 --auto-approve --batch-size 20

# Tier 3: full background run on the entire pending queue
./run_all.sh
./run_all.sh log     # tail the log
./run_all.sh stop    # kill it
```

Ollama setup (one-time):
```bash
brew install ollama
brew services start ollama
ollama pull qwen2.5vl:7b
launchctl setenv OLLAMA_ORIGINS "https://www.youtube.com,https://youtube.com,chrome-extension://*,arc-extension://*"
```

The `OLLAMA_ORIGINS` line is also persisted in `~/Library/LaunchAgents/homebrew.mxcl.ollama.plist` so it survives reboots.

## Running the YouTube scraper

```bash
# edit scrape_config.json to add channels/queries you trust
python3 scrape_youtube.py            # writes youtube_candidates.json
python3 curate.py                    # opens :8766/curate.html — keep/reject grid
# kept candidates land in eagle-pending.json → auto_tag picks them up next batch
```

## Common pitfalls

| Problem | Fix |
|---------|-----|
| Extension button missing or shows old icon | Reload extension at `arc://extensions`, then Cmd+R on YouTube |
| Extension fails: "Ollama not running" | Actually a CORS error. Re-set OLLAMA_ORIGINS (see above) |
| "Already in board" toast | Worked correctly — duplicate detection caught it |
| URL bar tinting white in Arc | Scrollbar in lightbox was light grey; now styled dark via ::-webkit-scrollbar |
| Confirm-modal listener errors | Wrap in DOMContentLoaded — the modal is declared after the script |
| GitHub Pages builds erroring | The Worker batches commits via `/api/add-batch`. If you call `/api/add` in a loop, you'll blow through GitHub Pages' build quota |

## What's NOT done yet

These are open and would benefit from a focused session:
- A **scraper page on the web** (not local-only) — pending request
- Color-based search and OCR text-in-thumbnail search — pending request
- Manual upload of arbitrary thumbnails (not from YouTube) — pending request
