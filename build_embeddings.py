#!/usr/bin/env python3
"""
build_embeddings.py — for each summary in summaries/, send (title + tags +
summary) to the Worker's /api/ideas/embed endpoint, which generates an
embedding via CF Workers AI and upserts into Vectorize.

Reuses the auth pattern of the other scripts: TB_AUTH_TOKEN env var.

Maintains embedded.json as a manifest of IDs already indexed; skips
those on subsequent runs. Committed to the repo so the launchd tick
on your Mac knows what's new.

Usage:
  export TB_AUTH_TOKEN='...'
  python3 build_embeddings.py           # process every summary not yet in embedded.json
  python3 build_embeddings.py --ids ABC # specific IDs (forces re-embed)
"""
import argparse
import json
import os
import sys
import time
import urllib.request
import urllib.error
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

ROOT       = Path(__file__).parent
DATA       = ROOT / "data.json"
SUMMARIES  = ROOT / "summaries"
MANIFEST   = ROOT / "embedded.json"
WORKER_URL = "https://thumbnail-board-api.andrei-nndd.workers.dev"
WORKERS    = 3
TIMEOUT    = 60

OWN_TAGS = {"channel-theseniordev-main", "channel-theseniordev-podcast"}

def post_embed(item, token):
    payload = {
        "id":      item["id"],
        "text":    item["text"],
        "title":   item["title"],
        "channel": item["channel"],
        "is_own":  item["is_own"],
    }
    body = json.dumps(payload).encode()
    req = urllib.request.Request(
        f"{WORKER_URL}/api/ideas/embed",
        data=body,
        headers={"Content-Type": "application/json", "X-Auth-Token": token},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
            resp = json.loads(r.read().decode())
            if not resp.get("ok"):
                return {"id": item["id"], "status": "worker-error", "msg": resp.get("msg", "?")}
            return {"id": item["id"], "status": "ok"}
    except urllib.error.HTTPError as e:
        return {"id": item["id"], "status": "http-error", "msg": f"{e.code} {e.read()[:200].decode(errors='ignore')}"}
    except Exception as e:
        return {"id": item["id"], "status": "exception", "msg": str(e)[:200]}

def load_manifest():
    if not MANIFEST.exists():
        return set()
    try:
        return set(json.loads(MANIFEST.read_text()))
    except Exception:
        return set()

def save_manifest(ids):
    MANIFEST.write_text(json.dumps(sorted(ids), indent=2))

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--ids", help="Comma-separated IDs to re-embed (skips manifest check)")
    args = ap.parse_args()

    token = os.environ.get("TB_AUTH_TOKEN")
    if not token:
        print("ERROR: TB_AUTH_TOKEN env var not set", file=sys.stderr)
        sys.exit(1)

    data = json.loads(DATA.read_text())
    meta_by_id = {v["id"]: v for v in data if v.get("id")}

    embedded = load_manifest()

    if args.ids:
        candidate_ids = [s.strip() for s in args.ids.split(",") if s.strip()]
    else:
        if not SUMMARIES.exists():
            print(f"ERROR: {SUMMARIES} not found. Run summarize.py first.")
            sys.exit(1)
        candidate_ids = sorted(p.stem for p in SUMMARIES.glob("*.txt"))

    # Filter out already-embedded (unless --ids is explicit)
    todo_ids = candidate_ids if args.ids else [v for v in candidate_ids if v not in embedded]

    print(f"To embed: {len(todo_ids)} (skipped {len(candidate_ids) - len(todo_ids)} already in manifest)")
    if not todo_ids:
        print("Nothing to do.")
        return

    # Build payload for each
    items = []
    for vid in todo_ids:
        meta = meta_by_id.get(vid, {})
        sm_path = SUMMARIES / f"{vid}.txt"
        if not sm_path.exists():
            print(f"  ⚠ {vid}: missing summary, skipping")
            continue
        summary = sm_path.read_text().strip()
        tags = meta.get("tags", []) or []
        is_own = any(t in OWN_TAGS for t in tags)
        title = meta.get("title", "")
        channel = meta.get("channel", "")
        text = f"Title: {title}\nChannel: {channel}\nTags: {', '.join(tags)}\n\nSummary: {summary}"
        items.append({
            "id":      vid,
            "text":    text,
            "title":   title,
            "channel": channel,
            "is_own":  is_own,
        })

    print(f"Sending {len(items)} embed requests · {WORKERS} workers\n")

    started = time.time()
    results, done = [], 0
    new_in_manifest = []
    with ThreadPoolExecutor(max_workers=WORKERS) as ex:
        futures = {ex.submit(post_embed, item, token): item for item in items}
        for fut in as_completed(futures):
            r = fut.result()
            results.append(r)
            if r["status"] == "ok":
                new_in_manifest.append(r["id"])
            done += 1
            if done % 10 == 0 or done == len(items):
                elapsed = time.time() - started
                eta = (len(items) - done) * elapsed / done if done else 0
                print(f"  [{done:>4}/{len(items)}]  elapsed {elapsed/60:.1f}m  eta {eta/60:.1f}m", flush=True)

    embedded.update(new_in_manifest)
    save_manifest(embedded)

    by_status = {}
    for r in results:
        by_status[r["status"]] = by_status.get(r["status"], 0) + 1
    print(f"\n=== Done in {(time.time()-started)/60:.1f} min ===")
    for s, n in sorted(by_status.items(), key=lambda kv: -kv[1]):
        print(f"  {s:<15} {n}")
    print(f"\nmanifest now has {len(embedded)} IDs")

if __name__ == "__main__":
    main()
