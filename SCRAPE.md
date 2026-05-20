# YouTube scraping — web bot (primary) + local Python (legacy)

There are two scrapers in this repo:

1. **Web bot** (primary) — runs in the Cloudflare Worker, on a cron. Discovers new thumbnails from your niche, scores them with an outlier metric (à la VidIQ), and drops the best into a web inbox. You curate from your browser, no Mac required.
2. **Local Python scraper** (legacy) — `scrape_youtube.py` + `curate.py`. Still works, runs on your Mac via `yt-dlp`. Use it if the Worker bot is down or you want to scrape something specific without burning quota.

```
                       Web flow (primary)

    Cron (every 6h) ─► Worker.scheduled() ─► YouTube Data API v3
                                  │
                                  ▼
          filters + outlier scoring + dedup
                                  │
                                  ▼
                    scrape_inbox.json (in repo)
                                  │
                          inbox.html (UI)
                       │            │              │
                  Approve→pending  Approve→board  Reject
                       │            │              │
                       ▼            ▼              ▼
            eagle-pending.json   data.json    scrape_rejected.json
                       │
                       ▼
                 auto_tag.py picks up
                       │
                       ▼
                 published on the board
```

## How the web bot works

### Sources

`scrape_sources.json` (committed in repo, edit and commit to change):

```json
{
  "channels": ["@Fireship", "@ThePrimeagen", ...],
  "queries":  ["software engineering best practices", ...],
  "thresholds": {
    "min_views": 50000,
    "max_age_days": 730,
    "min_duration_seconds": 90,
    "min_outlier_score": 1.5,
    "cap_per_run": 30
  }
}
```

Three discovery paths per cron tick:

- **Channels** — for each `@handle`, fetch the last 15 uploads. ~3 quota units per channel.
- **Queries** — `search.list` per query, top 8 by `viewCount`. ⚠️ 100 quota units each, use sparingly.
- **Trending** — `videos.list?chart=mostPopular&videoCategoryId={27,28}`, top 25 of Education and Science & Tech.

### Filters (hardcoded in `worker/scrape.js`)

Applied in order. Anything that fails is dropped.

| Filter | Default |
|--------|---------|
| `categoryId ∈ {22, 24, 26, 27, 28}` | People&Blogs, Entertainment, Howto, Education, Science&Tech |
| Title / channel / description regex blocklist | `reaction\|prank\|asmr\|mukbang\|gameplay\|fortnite\|roblox\|minecraft\|cocomelon\|...` |
| Kids regex | `kids\|baby\|toddler\|niños\|...` |
| `#shorts` in title or description | Defense-in-depth against Shorts |
| `duration ≥ 90s` | Configurable in `thresholds` |
| `age ≤ 730 days` | Configurable in `thresholds` |
| `views ≥ 50000` | Configurable in `thresholds` |

### Outlier scoring

Inspired by VidIQ's "outlier multiplier" / 1of10's median method:

```
baseline = median(views_per_day(v) for v in last 50 uploads of the channel
                  where duration > 60s
                    and 30d ≤ age ≤ 365d)

target_vpd     = target.views / max(target.age_days, 1)
outlier_score  = target_vpd / baseline
confidence     = "high" if baseline_n ≥ 10 and target.age_days ≥ 14 else "low"
```

Candidates with `score < thresholds.min_outlier_score` (default 1.5) are dropped. The rest are sorted by score desc, capped to `cap_per_run` (default 30), and appended to `scrape_inbox.json` in one commit.

**Per-channel baseline cache** during a run keeps quota at ~50 units even when scoring 30 candidates from 15 different channels.

### Dedup

Before scoring, the Worker filters out any IDs already in: `data.json`, `eagle-pending.json`, `scrape_inbox.json`, `scrape_rejected.json`. Nothing reappears once rejected.

### Quota

YouTube Data API v3 limit: 10,000 units/day. Per cron run with the default sources:

- 10 channels × 2 units ≈ 20
- 11 queries × 101 units ≈ 1,111  ← bulk of the cost
- 2 trending × 1 unit = 2
- videos.list batch for details ≈ 5–10
- outlier baselines (cached per channel, ~15 unique) ≈ 45

**Total: ~1,200 units/run × 4 runs/day = ~4,800/day.** Holgado.

If you want to save quota, drop a few queries — they're the most expensive ones.

## The inbox UI (`inbox.html`)

- **Click** a card → mark `keep` (mint outline + tick in bottom-right)
- **Hover-X** in top-left → mark `reject` (red outline)
- **Click again** → undecided
- Sort: by score, by recent, by views
- Toggle "High confidence only" to hide cards with `low` confidence (young video or thin baseline)
- Outlier badge top-right: `xN` colored green/amber/grey by tier, dimmed-italic when low confidence
- Bulk: Keep all, Reject all, Clear
- Three commit buttons:
  - **Approve → pending** (default) — moves kept items to `eagle-pending.json`. `auto_tag.py` will tag them next time it runs.
  - **Approve → board** — moves kept items directly to `data.json` with empty tags. Skips auto-tag. Use sparingly. Confirmation modal first.
  - **Reject marked** — moves rejected items to `scrape_rejected.json` (just their IDs) and removes them from the inbox. They will never reappear.

The "Inbox (N)" badge on the public board (`index.html`, top-right FAB) shows the count.

## Operations

### Deploy

```bash
cd worker
wrangler secret put YOUTUBE_API_KEY        # one-time
wrangler deploy
```

### Manual trigger

From the UI: open `inbox.html` → "Run scraper now".

From CLI:

```bash
curl -X POST -H "X-Auth-Token: $TB_AUTH_TOKEN" \
  https://thumbnail-board-api.andrei-nndd.workers.dev/api/scrape/run
```

Returns `{ok, added, stats: { discovered, after_dedup, after_filters, after_outlier, kept, errors }}`.

### Enable the cron

After the manual trigger looks healthy, edit `worker/wrangler.toml`:

```toml
[triggers]
crons = ["0 */6 * * *"]
```

then `wrangler deploy`.

### Tweak thresholds

Edit `scrape_sources.json` in the repo and commit. The next run uses the new values — no redeploy, no Worker changes.

Common knobs:
- Inbox too noisy? Raise `min_outlier_score` from 1.5 to 2.0 or 3.0.
- Inbox too empty? Lower `min_views` from 50000 to 25000.
- Want only fresh stuff? Lower `max_age_days` to 180.

## Local scraper (legacy)

Still in the repo for offline / quota-free use. Reads `scrape_config.json` (separate file from the web bot's `scrape_sources.json` — they can diverge).

```bash
python3 scrape_youtube.py            # uses yt-dlp, writes youtube_candidates.json
python3 curate.py                    # opens :8766/curate.html — keep/reject grid
# kept candidates land in eagle-pending.json → auto_tag picks them up next batch
```

Does **not** compute outlier scores. Curation is purely visual.

## Tips

- **Don't lower `min_outlier_score` below 1.0** — at that point you're not filtering, you're just sorting noise.
- **`scrape_rejected.json` is permanent.** If you reject by mistake, you'd have to edit the file in the repo and remove the ID.
- **Quota anxiety**: each `search.list` is 100 units. If you add 30 queries, you're at ~3,000 units/run × 4/day = 12k/day, over limit. Keep queries focused.
- **Channel handles**: must be `@handle` form. The Worker resolves them via `channels.list?forHandle=`.
