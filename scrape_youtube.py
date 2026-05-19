#!/usr/bin/env python3
"""
scrape_youtube.py — fetch YouTube candidates for the board.

Reads scrape_config.json (search queries + channels + filters).
Uses yt-dlp to gather video metadata WITHOUT downloading anything.
De-duplicates against data.json (already on the board) and against
the existing candidates file.

Output: youtube_candidates.json (review with curate.py).

Usage:
  python3 scrape_youtube.py
  python3 scrape_youtube.py --queries-only      # skip channels
  python3 scrape_youtube.py --channels-only     # skip queries
  python3 scrape_youtube.py --fresh             # ignore prior candidates file
"""
from __future__ import annotations
import argparse, json, subprocess, sys, time, urllib.request
from datetime import datetime, timedelta
from pathlib import Path

ROOT = Path(__file__).parent
CONFIG_FILE       = ROOT / "scrape_config.json"
CANDIDATES_FILE   = ROOT / "youtube_candidates.json"
BOARD_FILE        = ROOT / "data.json"

WORKER_URL = "https://thumbnail-board-api.andrei-nndd.workers.dev"

def load_published_ids() -> set:
    """Returns set of video IDs already on the board.
    Prefer the live Worker copy, fall back to local data.json."""
    try:
        req = urllib.request.Request(f"{WORKER_URL}/api/data",
                                     headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req, timeout=10) as r:
            return {v["id"] for v in json.loads(r.read())}
    except Exception as e:
        print(f"⚠ couldn't reach Worker, using local data.json: {e}", file=sys.stderr)
        return {v["id"] for v in json.loads(BOARD_FILE.read_text())}

def yt_dlp_search(query: str, limit: int) -> list:
    """Run yt-dlp search and return parsed metadata for each result."""
    target = f"ytsearch{limit}:{query}"
    cmd = ["yt-dlp", target, "--flat-playlist", "--dump-json",
           "--no-warnings", "--default-search", "ytsearch"]
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
    except subprocess.TimeoutExpired:
        print(f"  ⚠ timeout on query: {query}", file=sys.stderr)
        return []
    items = []
    for line in result.stdout.splitlines():
        line = line.strip()
        if not line: continue
        try: items.append(json.loads(line))
        except: pass
    return items

def yt_dlp_channel(handle: str, limit: int) -> list:
    """Fetch the latest N videos from a channel."""
    url = f"https://www.youtube.com/{handle}/videos"
    cmd = ["yt-dlp", url, "--flat-playlist", "--dump-json", "--no-warnings",
           "--playlist-end", str(limit)]
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
    except subprocess.TimeoutExpired:
        print(f"  ⚠ timeout on channel: {handle}", file=sys.stderr)
        return []
    items = []
    for line in result.stdout.splitlines():
        line = line.strip()
        if not line: continue
        try: items.append(json.loads(line))
        except: pass
    return items

def passes_filters(item: dict, f: dict) -> tuple[bool, str]:
    """Apply config filters. Returns (ok, reason)."""
    # Shorts detection
    if f.get("exclude_shorts"):
        url = item.get("url", "") or item.get("webpage_url", "")
        if "/shorts/" in url:
            return False, "is short"
    # Duration
    dur = item.get("duration") or 0
    if dur and dur < f.get("min_duration_seconds", 0):
        return False, f"duration {dur}s < min"
    # Views
    views = item.get("view_count") or 0
    if views and views < f.get("min_views", 0):
        return False, f"views {views} < min"
    # Age — yt-dlp returns timestamp (unix) or upload_date (YYYYMMDD)
    if f.get("max_age_days"):
        ts = item.get("timestamp")
        if not ts:
            ud = item.get("upload_date")
            if ud and len(ud) == 8:
                try:
                    ts = datetime.strptime(ud, "%Y%m%d").timestamp()
                except: ts = None
        if ts:
            age_days = (time.time() - ts) / 86400
            if age_days > f["max_age_days"]:
                return False, f"too old ({int(age_days)}d)"
    # Made for kids
    if item.get("availability") == "needs_auth":
        return False, "needs auth"
    return True, ""

def normalise_views(n) -> str:
    if not n: return ""
    n = int(n)
    if n >= 1_000_000: return f"{n/1_000_000:.1f}M".replace(".0M","M")
    if n >= 1_000:     return f"{n/1_000:.1f}K".replace(".0K","K")
    return str(n)

def to_candidate(item: dict, source: str) -> dict:
    vid = item.get("id", "")
    title = item.get("title", "") or ""
    channel = item.get("channel") or item.get("uploader") or ""
    views = normalise_views(item.get("view_count"))
    return {
        "id": vid, "eid": "",
        "title": title, "channel": channel, "views": views,
        "tags": [],
        "_source": source,
        "_view_count": item.get("view_count") or 0,
        "_duration": item.get("duration") or 0,
        "_url": item.get("url") or f"https://www.youtube.com/watch?v={vid}",
    }

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--queries-only",  action="store_true")
    ap.add_argument("--channels-only", action="store_true")
    ap.add_argument("--fresh", action="store_true", help="Ignore existing youtube_candidates.json")
    args = ap.parse_args()

    cfg = json.loads(CONFIG_FILE.read_text())
    f = cfg.get("filters", {})

    published = load_published_ids()
    existing_candidates = []
    if CANDIDATES_FILE.exists() and not args.fresh:
        try: existing_candidates = json.loads(CANDIDATES_FILE.read_text())
        except: pass
    existing_ids = set(c["id"] for c in existing_candidates)

    print(f"📊 Already in board: {len(published)} | Existing candidates: {len(existing_candidates)}")
    print(f"🔎 Scraping…\n")

    new_items = []
    seen_now = set()

    if not args.channels_only:
        for q in cfg.get("search_queries", []):
            print(f"  query: {q}")
            items = yt_dlp_search(q, f.get("items_per_query", 8))
            kept = 0
            for it in items:
                vid = it.get("id", "")
                if not vid or vid in published or vid in existing_ids or vid in seen_now:
                    continue
                ok, reason = passes_filters(it, f)
                if not ok: continue
                seen_now.add(vid)
                new_items.append(to_candidate(it, f"query:{q}"))
                kept += 1
            print(f"    + {kept} new")

    if not args.queries_only:
        for ch in cfg.get("channels", []):
            print(f"  channel: {ch}")
            items = yt_dlp_channel(ch, f.get("videos_per_channel", 6))
            kept = 0
            for it in items:
                vid = it.get("id", "")
                if not vid or vid in published or vid in existing_ids or vid in seen_now:
                    continue
                ok, reason = passes_filters(it, f)
                if not ok: continue
                seen_now.add(vid)
                new_items.append(to_candidate(it, f"channel:{ch}"))
                kept += 1
            print(f"    + {kept} new")

    # Merge with existing, sort by view count desc
    all_candidates = existing_candidates + new_items
    all_candidates.sort(key=lambda c: c.get("_view_count", 0), reverse=True)
    CANDIDATES_FILE.write_text(json.dumps(all_candidates, ensure_ascii=False, indent=2))

    print(f"\n✅ {len(new_items)} new candidates added. Total queued: {len(all_candidates)}")
    print(f"   Next: python3 curate.py    # pick which ones to keep")

if __name__ == "__main__":
    main()
