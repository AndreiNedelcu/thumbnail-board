#!/usr/bin/env python3
"""
enrich_discovery.py — pop items off the Worker's discovery_queue.json,
fetch each one's transcript (yt-dlp captions, then Whisper if needed),
and POST it back to /api/ideas/discovery-enrich so the Worker can
re-embed with a richer vector.

Designed to run from index_tick.sh after the board pipeline. Cheap:
- no Anthropic API calls (no summary needed)
- transcripts are reused from the same transcripts/ directory the board uses
- Whisper local (M1 Ultra) when YT auto-captions aren't available
"""
import json
import os
import subprocess
import sys
import time
import urllib.request
import urllib.error
from pathlib import Path

ROOT       = Path(__file__).parent
TX_DIR     = ROOT / "transcripts"
WORKER_URL = "https://thumbnail-board-api.andrei-nndd.workers.dev"

def fetch_queue(token):
    req = urllib.request.Request(
        f"{WORKER_URL}/api/ideas/discovery-queue",
        headers={"X-Auth-Token": token, "User-Agent": "tb-enrich/1.0"},
    )
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read().decode())

def call_enrich(token, payload):
    body = json.dumps(payload).encode()
    req = urllib.request.Request(
        f"{WORKER_URL}/api/ideas/discovery-enrich",
        data=body,
        headers={"Content-Type": "application/json", "X-Auth-Token": token,
                 "User-Agent": "tb-enrich/1.0"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read().decode())

def ensure_transcript(vid):
    """Reuse transcripts/{vid}.txt if it exists, otherwise extract or Whisper."""
    p = TX_DIR / f"{vid}.txt"
    if p.exists() and p.stat().st_size > 100:
        return p.read_text()

    # Try yt-dlp captions first
    r = subprocess.run(
        ["python3", str(ROOT / "extract_transcripts.py"), f"--ids={vid}", "--workers=1"],
        capture_output=True, text=True, timeout=180,
    )
    if p.exists() and p.stat().st_size > 100:
        return p.read_text()

    # Fall back to Whisper if model is around
    if (ROOT / "models" / "ggml-large-v3-turbo.bin").exists():
        r = subprocess.run(
            ["python3", str(ROOT / "whisper_transcripts.py"), f"--ids={vid}"],
            capture_output=True, text=True, timeout=900,
        )
        if p.exists() and p.stat().st_size > 100:
            return p.read_text()
    return None

def main():
    token = os.environ.get("TB_AUTH_TOKEN", "")
    if not token:
        print("ERROR: TB_AUTH_TOKEN not set", file=sys.stderr)
        sys.exit(1)

    try:
        queue = fetch_queue(token)
    except Exception as e:
        print(f"ERROR fetching queue: {e}", file=sys.stderr)
        sys.exit(1)

    if not queue:
        print("Discovery queue empty, nothing to do.")
        return

    print(f"Enriching {len(queue)} discovery videos…")
    enriched = 0
    skipped = 0
    failed = 0
    started = time.time()

    for i, item in enumerate(queue, 1):
        vid     = item.get("id")
        title   = item.get("title", "")
        channel = item.get("channel", "")
        if not vid: continue

        tx = ensure_transcript(vid)
        if not tx:
            print(f"  [{i:>3}/{len(queue)}] ✗ {vid}  no transcript (skipped)", flush=True)
            skipped += 1
            continue

        try:
            r = call_enrich(token, {
                "id": vid, "title": title, "channel": channel,
                "transcript": tx[:12000],
            })
            if r.get("ok"):
                enriched += 1
                print(f"  [{i:>3}/{len(queue)}] ✓ {vid}  {title[:50]}", flush=True)
            else:
                failed += 1
                print(f"  [{i:>3}/{len(queue)}] ✗ {vid}  worker: {r.get('msg','?')}", flush=True)
        except Exception as e:
            failed += 1
            print(f"  [{i:>3}/{len(queue)}] ✗ {vid}  {type(e).__name__}: {e}", flush=True)

    print(f"\n=== Done in {(time.time()-started)/60:.1f} min ===")
    print(f"  enriched: {enriched}")
    print(f"  skipped:  {skipped}  (no transcript available)")
    print(f"  failed:   {failed}")

if __name__ == "__main__":
    main()
