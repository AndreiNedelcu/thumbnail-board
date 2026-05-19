#!/usr/bin/env python3
"""
sync.py — Sync Eagle thumbnail library → thumbnail-board website

Reads all items from Eagle folder "Thumbnail-Examples-Claude",
filters those with valid category tags, generates data.json,
and pushes to GitHub so the website updates automatically.

Usage:
    python3 sync.py           # sync and push
    python3 sync.py --dry-run # preview only, don't push
"""

import json, re, sys, subprocess, requests
from pathlib import Path

EAGLE_API  = "http://localhost:41595"
FOLDER_ID  = "MPBRJ4DRT0IR0"
EAGLE_MCP  = "http://localhost:41596"
OUT_FILE   = Path(__file__).parent / "data.json"

# Valid tag prefixes (from thumbnailexamples.com taxonomy)
VALID_PREFIXES = {
    "style", "mood", "text", "element", "camera",
    "subject", "formation", "topic", "callout", "backdrop",
}

# Typo corrections
TYPO_MAP = {
    "mood-suprised": "mood-surprised", "mood-surpised": "mood-surprised",
    "background-blurry": "backdrop-blurry", "backround-blurry": "backdrop-blurry",
    "dark-backdrop": "backdrop-dark", "backdrop-black": "backdrop-dark",
    "backdrop-ligh": "backdrop-light", "backdrop-blur": "backdrop-blurry",
    "stle-photoshopped": "style-photoshopped", "style-collate": "style-collage",
    "style-identity": "text-identity", "style-minmal": "style-minimal",
    "style-rd": None, "style-split-view": "style-split-screen",
    "style-handdranw": "style-handdrawn", "formation-overhead-shot": None,
    "mode-entertaining": "mood-entertaining", "mode-happy": "mood-happy",
    "callout-text": None, "element-eyes": "element-eye",
    "text-numbber": "text-number", "text-forwad-referencing": "text-forward-referencing",
    "subject-behidn-object": None, "subject-count-one": None,
    "mood-disgusted": None, "callout": None, "contrst": None,
}

YT_RE = re.compile(r"(?:watch\?v=|youtu\.be/)([A-Za-z0-9_-]{11})")

session = requests.Session()
session.headers["User-Agent"] = "Mozilla/5.0"


def get_all_items():
    """Read all items from Eagle folder via REST API + disk metadata."""
    seen = set()
    items = []

    for order in ["CREATEDATE", "NAME", "FILESIZE", "MODIFYDATE", "WIDTH", "HEIGHT"]:
        offset = 0
        while True:
            r = session.get(f"{EAGLE_API}/api/item/list",
                            params={"folders[]": FOLDER_ID, "limit": 200,
                                    "offset": offset, "orderBy": order},
                            timeout=15)
            batch = r.json().get("data", []) if r.status_code == 200 else []
            if not batch:
                break
            for b in batch:
                if b["id"] not in seen:
                    seen.add(b["id"])
                    # Try to read full metadata from disk
                    fp = b.get("filePath", "")
                    if fp:
                        meta_path = Path(fp).parent / "metadata.json"
                        try:
                            items.append(json.loads(meta_path.read_text()))
                            continue
                        except Exception:
                            pass
                    items.append(b)
            if len(batch) < 200:
                break
            offset += 200

    print(f"  Found {len(items)} total items in Eagle folder")
    return items


def canonicalize_tags(raw_tags):
    """Clean and filter tags to only valid category tags."""
    result = []
    seen = set()
    for t in raw_tags:
        canon = TYPO_MAP.get(t, t)
        if canon is None:
            continue
        prefix = canon.split("-")[0] if "-" in canon else ""
        if prefix not in VALID_PREFIXES:
            continue
        if canon not in seen:
            result.append(canon)
            seen.add(canon)
    return result


def extract_video_id(item):
    """Extract YouTube video ID from item URL or annotation."""
    for field in ["url", "annotation"]:
        val = item.get(field, "") or ""
        m = YT_RE.search(val)
        if m:
            return m.group(1)
    return None


def build_dataset(items):
    """Convert Eagle items → web-ready list."""
    result = []
    skipped_no_id = 0
    skipped_no_tags = 0

    for item in items:
        vid_id = extract_video_id(item)
        if not vid_id:
            skipped_no_id += 1
            continue

        raw_tags = item.get("tags") or []
        # Also check annotation for tags if item has none
        tags = canonicalize_tags(raw_tags)
        if not tags:
            skipped_no_tags += 1
            continue

        result.append({
            "id": vid_id,
            "title": item.get("name") or "",
            "channel": "",  # Eagle doesn't store channel separately
            "tags": tags,
        })

    # Deduplicate by video ID (keep first seen)
    seen = set()
    deduped = []
    for v in result:
        if v["id"] not in seen:
            seen.add(v["id"])
            deduped.append(v)

    print(f"  Videos with valid tags: {len(deduped)}")
    print(f"  Skipped (no YouTube ID): {skipped_no_id}")
    print(f"  Skipped (no valid tags): {skipped_no_tags}")
    return deduped


def push_to_github():
    """Commit data.json and push to GitHub."""
    repo_dir = Path(__file__).parent
    try:
        subprocess.run(["git", "add", "data.json"], cwd=repo_dir, check=True)
        result = subprocess.run(["git", "diff", "--cached", "--stat"],
                                cwd=repo_dir, capture_output=True, text=True)
        if not result.stdout.strip():
            print("  No changes to push.")
            return

        subprocess.run(["git", "commit", "-m", "sync: update thumbnail data from Eagle"],
                       cwd=repo_dir, check=True)
        subprocess.run(["git", "push"], cwd=repo_dir, check=True)
        print("  ✅ Pushed to GitHub — website will update in ~30 seconds")
    except subprocess.CalledProcessError as e:
        print(f"  ❌ Git error: {e}")


def main():
    dry_run = "--dry-run" in sys.argv
    print("=" * 50)
    print("  Thumbnail Board — Eagle Sync")
    print("=" * 50)

    print("\n1. Reading items from Eagle…")
    items = get_all_items()

    print("\n2. Building dataset…")
    dataset = build_dataset(items)

    print(f"\n3. Writing {OUT_FILE.name}…")
    OUT_FILE.write_text(json.dumps(dataset, ensure_ascii=False, separators=(",", ":")))
    print(f"   Size: {OUT_FILE.stat().st_size:,} bytes")

    if dry_run:
        print("\n  [dry-run] Skipping GitHub push.")
    else:
        print("\n4. Pushing to GitHub…")
        push_to_github()

    print("\n✅ Done!\n")


if __name__ == "__main__":
    main()
