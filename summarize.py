#!/usr/bin/env python3
"""
summarize.py — for each transcripts/{id}.txt, generate a 200-word
summary with Claude Haiku 4.5 and save to summaries/{id}.txt.

Reads ANTHROPIC_API_KEY from the environment. Resumable: skips IDs
that already have a summary. Idempotent within a single run via a
per-call retry on transient errors.

Usage:
  export ANTHROPIC_API_KEY='sk-ant-...'
  pip install anthropic
  python3 summarize.py            # process every transcript missing a summary
  python3 summarize.py --ids ABC  # only specific IDs

Cost: ~$0.005 per video at 5000-token transcript truncation.
"""
import argparse
import json
import os
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

try:
    from anthropic import Anthropic
except ImportError:
    print("ERROR: pip install anthropic", file=sys.stderr)
    sys.exit(1)

ROOT          = Path(__file__).parent
TRANSCRIPTS   = ROOT / "transcripts"
SUMMARIES     = ROOT / "summaries"
DATA          = ROOT / "data.json"

MODEL         = "claude-haiku-4-5"
MAX_INPUT_CHARS  = 20_000   # roughly 5000 tokens
MAX_OUTPUT_TOKENS = 400      # ~200 words of summary
WORKERS       = 4

SYSTEM_PROMPT = """You write concise factual summaries of YouTube video transcripts.
Output exactly one paragraph of about 150-200 words capturing:
- The video's main topic and angle
- Key concepts / entities / technologies discussed
- What kind of audience it targets
Do NOT mention the video's title, channel name, intro filler, sponsorships, or call-to-actions.
Write in English regardless of the transcript's language. Plain prose, no bullet points, no preamble."""

def load_meta_map():
    """Map id → {title, channel} from data.json for prompt context."""
    by_id = {}
    for v in json.loads(DATA.read_text()):
        if v.get("id"):
            by_id[v["id"]] = {"title": v.get("title", ""), "channel": v.get("channel", "")}
    return by_id

def summarize_one(client, vid, meta):
    out_path = SUMMARIES / f"{vid}.txt"
    if out_path.exists() and out_path.stat().st_size > 50:
        return {"id": vid, "status": "already"}

    tx_path = TRANSCRIPTS / f"{vid}.txt"
    if not tx_path.exists():
        return {"id": vid, "status": "no-transcript"}
    transcript = tx_path.read_text()[:MAX_INPUT_CHARS]
    if len(transcript) < 100:
        return {"id": vid, "status": "transcript-too-short"}

    title   = meta.get("title", "")
    channel = meta.get("channel", "")
    user_msg = (
        f"Video title: {title}\n"
        f"Channel: {channel}\n\n"
        f"Transcript (may be truncated):\n{transcript}"
    )

    for attempt in range(3):
        try:
            resp = client.messages.create(
                model=MODEL,
                max_tokens=MAX_OUTPUT_TOKENS,
                system=SYSTEM_PROMPT,
                messages=[{"role": "user", "content": user_msg}],
            )
            text = "".join(b.text for b in resp.content if hasattr(b, "text")).strip()
            if not text:
                return {"id": vid, "status": "empty-response"}
            out_path.write_text(text)
            return {"id": vid, "status": "ok", "chars": len(text)}
        except Exception as e:
            if attempt == 2:
                return {"id": vid, "status": "error", "error": str(e)[:200]}
            time.sleep(1 + attempt)

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--ids", help="Comma-separated IDs to process (default: all transcripts)")
    args = ap.parse_args()

    if not os.environ.get("ANTHROPIC_API_KEY"):
        print("ERROR: ANTHROPIC_API_KEY not set in environment", file=sys.stderr)
        sys.exit(1)

    SUMMARIES.mkdir(exist_ok=True)
    meta_by_id = load_meta_map()

    if args.ids:
        ids = [s.strip() for s in args.ids.split(",") if s.strip()]
    else:
        if not TRANSCRIPTS.exists():
            print(f"ERROR: {TRANSCRIPTS} doesn't exist. Run extract_transcripts.py first.")
            sys.exit(1)
        ids = sorted(p.stem for p in TRANSCRIPTS.glob("*.txt"))

    print(f"Summarizing {len(ids)} transcripts with {MODEL} · {WORKERS} workers")
    print(f"Output: {SUMMARIES}/\n")

    client = Anthropic()
    started = time.time()
    results, done = [], 0
    with ThreadPoolExecutor(max_workers=WORKERS) as ex:
        futures = {ex.submit(summarize_one, client, v, meta_by_id.get(v, {})): v for v in ids}
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
