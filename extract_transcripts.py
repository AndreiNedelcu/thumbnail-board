#!/usr/bin/env python3
"""
extract_transcripts.py — pull plain-text transcripts for videos in
data.json using yt-dlp's auto-captions (Chrome cookies bypass YT's
bot check).

Usage:
  python3 extract_transcripts.py                # default: top 50 by views
  python3 extract_transcripts.py --top-views 100
  python3 extract_transcripts.py --all          # everything in data.json
  python3 extract_transcripts.py --ids ABC,DEF  # specific IDs

Output: transcripts/{videoId}.txt (gitignored — large + regenerable)
Skips IDs that already have a transcript file.
"""
import argparse
import json
import re
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

ROOT      = Path(__file__).parent
DATA      = ROOT / "data.json"
OUT_DIR   = ROOT / "transcripts"
WORKERS   = 3
TIMEOUT   = 90  # yt-dlp can be slow to fetch subs

def parse_views(s):
    """'1.2M' → 1200000, '847K' → 847000, '1234' → 1234, '' → 0"""
    if not s: return 0
    s = s.strip().upper()
    m = re.match(r"^([\d.]+)([KM]?)$", s)
    if not m: return 0
    n, unit = float(m.group(1)), m.group(2)
    return int(n * (1_000_000 if unit == "M" else 1_000 if unit == "K" else 1))

def vtt_to_plain(vtt_text):
    """Strip WEBVTT cue numbers, timestamps, inline tags. De-dupe consecutive lines."""
    out = []
    for raw in vtt_text.split("\n"):
        line = raw.strip()
        if not line: continue
        if line.startswith("WEBVTT"): continue
        if line.startswith("Kind:") or line.startswith("Language:"): continue
        if "-->" in line: continue
        if re.match(r"^\d+$", line): continue
        line = re.sub(r"<[^>]+>", "", line)             # <c.colorE5E5E5> tags
        line = re.sub(r"&nbsp;|&amp;", " ", line)
        out.append(line)
    deduped = []
    for line in out:
        if not deduped or deduped[-1] != line:
            deduped.append(line)
    return " ".join(deduped).strip()

def extract_one(vid):
    txt_path = OUT_DIR / f"{vid}.txt"
    if txt_path.exists() and txt_path.stat().st_size > 50:
        return {"id": vid, "status": "already"}

    cmd = [
        "yt-dlp",
        "--cookies-from-browser", "chrome",
        "--skip-download",
        "--write-auto-subs",
        "--sub-langs", "en,es",   # plain "en"/"es" — yt-dlp picks the best variant
        "--sub-format", "vtt",
        "--no-warnings",
        "-o", f"{OUT_DIR}/%(id)s.%(ext)s",
        f"https://www.youtube.com/watch?v={vid}",
    ]
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=TIMEOUT)
    except subprocess.TimeoutExpired:
        return {"id": vid, "status": "timeout"}

    # IMPORTANT: don't bail on non-zero exit. yt-dlp returns non-zero if e.g.
    # the "es" sub fetches a 429 even after the "en" was already saved to disk.
    # Always check for .vtt files on disk first.
    vtt_files = list(OUT_DIR.glob(f"{vid}.*.vtt"))

    if not vtt_files:
        # No vtt produced at all → real failure
        err = (r.stderr or "")[:160].strip()
        if r.returncode != 0:
            return {"id": vid, "status": "yt-dlp-error", "error": err}
        return {"id": vid, "status": "no-captions-available"}

    # Prefer English if available, else first match
    LANG_PRIORITY = ["en-orig", "en-US", "en-GB", "en", "en-en", "es-419", "es-US", "es", "es-es"]
    def rank(f):
        # filename: {id}.{lang}.vtt → take the {lang} part
        parts = f.stem.rsplit(".", 1)
        lang = parts[1] if len(parts) == 2 else ""
        return LANG_PRIORITY.index(lang) if lang in LANG_PRIORITY else len(LANG_PRIORITY)
    vtt_files.sort(key=rank)
    vtt = vtt_files[0]

    text = vtt_to_plain(vtt.read_text())
    for f in vtt_files: f.unlink(missing_ok=True)

    if not text or len(text) < 100:
        return {"id": vid, "status": "empty-transcript"}

    txt_path.write_text(text)
    return {"id": vid, "status": "ok", "chars": len(text)}

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--top-views", type=int, default=50, help="Take top N by views (default 50, MVP)")
    ap.add_argument("--all", action="store_true", help="Process every video in data.json")
    ap.add_argument("--ids", help="Comma-separated video IDs to process (overrides others)")
    args = ap.parse_args()

    OUT_DIR.mkdir(exist_ok=True)
    data = json.loads(DATA.read_text())

    if args.ids:
        ids = [s.strip() for s in args.ids.split(",") if s.strip()]
    elif args.all:
        ids = [v["id"] for v in data if v.get("id")]
    else:
        sorted_v = sorted(data, key=lambda v: parse_views(v.get("views", "")), reverse=True)
        ids = [v["id"] for v in sorted_v[:args.top_views]]

    print(f"Extracting transcripts for {len(ids)} videos · {WORKERS} workers · timeout {TIMEOUT}s")
    print(f"Output: {OUT_DIR}/\n")

    started = time.time()
    results, done = [], 0
    with ThreadPoolExecutor(max_workers=WORKERS) as ex:
        futures = {ex.submit(extract_one, v): v for v in ids}
        for fut in as_completed(futures):
            results.append(fut.result())
            done += 1
            if done % 10 == 0 or done == len(ids):
                elapsed = time.time() - started
                eta = (len(ids) - done) * elapsed / done if done else 0
                print(f"  [{done:>4}/{len(ids)}]  elapsed {elapsed/60:.1f}m  eta {eta/60:.1f}m", flush=True)

    by_status = {}
    for r in results:
        by_status[r["status"]] = by_status.get(r["status"], 0) + 1
    print(f"\n=== Done in {(time.time()-started)/60:.1f} min ===")
    for s, n in sorted(by_status.items(), key=lambda kv: -kv[1]):
        print(f"  {s:<25} {n}")

if __name__ == "__main__":
    main()
