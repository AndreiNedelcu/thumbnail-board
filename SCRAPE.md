# YouTube niche scraper

> **Note (current state):** Today the scraper is **local-only** — it runs on the
> user's Mac via `yt-dlp` (no API key needed) and produces a candidates file you
> curate through a localhost UI. A **web-based scraper page** (a separate tab on
> the GitHub Pages board, so anyone with the AUTH_TOKEN can scrape and curate
> from a browser) is the next planned feature. It will likely use the YouTube
> Data API v3 — yt-dlp can't run inside a Cloudflare Worker. See the "What's
> NOT done yet" section of `ONBOARDING.md`.

Pipeline to find great thumbnails from your niche and curate them
before adding to the board.

```
scrape_youtube.py  →  youtube_candidates.json  →  curate.py (UI)
                                                       ↓
                                              eagle-pending.json
                                                       ↓
                                              auto_tag.py picks up
                                                       ↓
                                              published on the board
```

## 1. Configure what to scrape

Edit `scrape_config.json`:

```json
{
  "search_queries": [...],   // niche search terms
  "channels": [...],         // @handles of creators you trust
  "filters": {
    "min_views": 50000,
    "min_duration_seconds": 90,   // skip shorts AND tiny vlogs
    "exclude_shorts": true,
    "max_age_days": 730,          // ignore stale stuff
    "items_per_query": 8,
    "videos_per_channel": 6
  }
}
```

The defaults target tech / dev / education. Add channels you respect,
add queries for topics you care about. The script de-duplicates against
the board so you only ever see new stuff.

## 2. Scrape

```bash
python3 scrape_youtube.py            # query searches + channel lists
python3 scrape_youtube.py --queries-only
python3 scrape_youtube.py --channels-only
python3 scrape_youtube.py --fresh    # ignore prior candidates file
```

Writes `youtube_candidates.json` sorted by view count (highest first).

## 3. Curate

```bash
python3 curate.py
```

Opens `http://localhost:8766/curate.html` — a grid of all candidates.

- **Click a thumbnail** → marks it as Keep (mint outline + ✓)
- **Click again** → undecided
- **Hover** → small X appears top-left to mark as Reject (red, faded)
- **Bulk**: "Keep all", "Reject all", "Clear"
- **"Process selection"** at the top:
  - Kept items go to `eagle-pending.json`
  - Rejected items go to `youtube_discarded.json` (kept for reference)
  - Undecided ones stay in `youtube_candidates.json` for later

## 4. Auto-tag picks them up

Whenever you run `auto_tag.py` it reads from `eagle-pending.json`, so
your kept candidates flow through the same pipeline as the Eagle import.

If `auto_tag.py --batch 0 --auto-approve` is running, kept candidates
are processed in the next loop iteration.

## Tips

- **Run scrape once a week.** Trending changes fast. Set a cron job if
  you want, or just remember to run it.
- **Tune queries iteratively.** When a query brings too much noise, drop
  it from the config. When you discover a new great creator, add their
  handle to `channels`.
- **Filter too strict?** Lower `min_views` if you're missing fresh hits.
- **Filter too loose?** Raise `min_views` or shrink `max_age_days`.
- **Discarded list grows large.** That's fine — it's audit trail.
  Wipe it occasionally with `rm youtube_discarded.json`.
