#!/usr/bin/env python3
"""
backfill_views.py — fix items in data.json that have no views (or a
broken value like a date instead of a number).

For each item, fetches the live view count from YouTube via yt-dlp
(no API key needed) and PATCHes it through the Worker's
/api/update-batch endpoint so the public board is corrected.

Usage:
  export TB_AUTH_TOKEN='...'
  python3 backfill_views.py                  # process all broken items
  python3 backfill_views.py --limit 50       # first 50 only (testing)
  python3 backfill_views.py --batch-size 40  # how many to send per commit
"""
from __future__ import annotations
import argparse, json, re, subprocess, sys, time, urllib.request
from pathlib import Path

ROOT = Path(__file__).parent
DATA_FILE = ROOT / "data.json"
WORKER_URL = "https://thumbnail-board-api.andrei-nndd.workers.dev"

VIEW_RE = re.compile(r'^\s*[\d.,]+\s*[KkMmBb]?\s*$')

def looks_like_valid_views(v) -> bool:
    """True if the string looks like a view count (number, possibly with K/M/B)."""
    if not v: return False
    s = str(v).strip()
    return bool(VIEW_RE.match(s))

def format_views(n: int) -> str:
    """Convert raw int to compact YouTube-style string: 1.2M, 847K, 23."""
    if n >= 1_000_000:
        v = n / 1_000_000
        return f"{v:.1f}".rstrip('0').rstrip('.') + 'M'
    if n >= 1_000:
        v = n / 1_000
        return f"{v:.1f}".rstrip('0').rstrip('.') + 'K'
    return str(n)

def fetch_view_count(video_id: str) -> int | None:
    """Use yt-dlp to grab metadata for one video. Returns view count or None."""
    url = f"https://www.youtube.com/watch?v={video_id}"
    try:
        result = subprocess.run(
            ['yt-dlp', '--no-warnings', '--skip-download', '--dump-json',
             '--no-playlist', url],
            capture_output=True, text=True, timeout=30
        )
    except subprocess.TimeoutExpired:
        print(f"    ⚠ timeout on {video_id}", file=sys.stderr)
        return None
    if result.returncode != 0:
        # Private/deleted/region-blocked etc.
        return None
    try:
        info = json.loads(result.stdout)
        return info.get('view_count')
    except Exception:
        return None

def post_batch(items: list, token: str) -> bool:
    payload = json.dumps({"items": items}).encode()
    req = urllib.request.Request(
        f"{WORKER_URL}/api/update-batch",
        data=payload,
        headers={
            "Content-Type": "application/json",
            "X-Auth-Token": token,
            "User-Agent": "ThumbnailBoardBackfill/1.0",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            resp = json.loads(r.read())
    except Exception as e:
        print(f"  ❌ POST failed: {e}", file=sys.stderr)
        return False
    if not resp.get("ok"):
        print(f"  ❌ Worker said no: {resp}", file=sys.stderr)
        return False
    print(f"  ✓ committed batch (updated {resp.get('updated', '?')})")
    return True

def main():
    import os
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=0, help="Process only first N items")
    ap.add_argument("--batch-size", type=int, default=40, help="Items per commit")
    args = ap.parse_args()

    token = os.environ.get("TB_AUTH_TOKEN", "")
    if not token:
        print("⚠ Set TB_AUTH_TOKEN env var first", file=sys.stderr)
        sys.exit(1)

    data = json.loads(DATA_FILE.read_text())
    broken = [v for v in data if not looks_like_valid_views(v.get('views', ''))]
    print(f"📊 Total items: {len(data)}")
    print(f"   Broken views: {len(broken)}")

    if args.limit > 0:
        broken = broken[:args.limit]
    print(f"   Processing now: {len(broken)}\n")

    pending = []   # accumulated for batch flush
    fixed = 0
    skipped = 0
    t0 = time.time()
    for i, v in enumerate(broken, 1):
        vid = v['id']
        elapsed = time.time() - t0
        rate = elapsed / max(i - 1, 1)
        eta = rate * (len(broken) - i)
        print(f"[{i:4d}/{len(broken)}] {vid}  '{v.get('title','')[:50]}'  (eta {eta/60:.0f}min)")
        n = fetch_view_count(vid)
        if n is None:
            print(f"    ⚠ no view count (private/deleted?) — skipping")
            skipped += 1
            continue
        views_str = format_views(n)
        pending.append({"vid": vid, "views": views_str})
        print(f"    ✓ {n:,} → {views_str}")
        fixed += 1

        if len(pending) >= args.batch_size:
            post_batch(pending, token)
            pending = []

    if pending:
        post_batch(pending, token)

    print(f"\n✅ Done. Fixed: {fixed} | Skipped: {skipped}")

if __name__ == "__main__":
    main()
