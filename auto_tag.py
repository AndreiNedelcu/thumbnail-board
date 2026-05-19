#!/usr/bin/env python3
"""
auto_tag.py — Auto-tag pending Eagle thumbnails using local Ollama + Qwen2.5-VL.

Pipeline:
  1. Reads eagle-pending.json (snapshot of items needing tags)
  2. For each: downloads thumbnail, asks Qwen2.5-VL with few-shot examples
     drawn from already-tagged items in data.json
  3. Parses JSON response, validates tags, saves to pending_review.json
  4. NEVER uploads automatically. You review with `review.py` first.

Usage:
  python3 auto_tag.py                  # process everything pending
  python3 auto_tag.py --limit 10       # process only first 10 (for testing)
  python3 auto_tag.py --resume         # skip items already in pending_review.json
  python3 auto_tag.py --model qwen2.5vl:7b
"""
from __future__ import annotations
import argparse, base64, json, os, random, re, sys, time
from pathlib import Path
from urllib.request import urlopen, Request

ROOT = Path(__file__).parent
PENDING_FILE   = ROOT / "eagle-pending.json"
BOARD_FILE     = ROOT / "data.json"
REVIEW_FILE    = ROOT / "pending_review.json"
SKIP_FILE      = ROOT / "auto_tag_skip.json"
FEEDBACK_FILE  = ROOT / "auto_tag_feedback.json"
AUTO_PUBLISHED_FILE = ROOT / "auto_published_log.json"  # audit log when --auto-approve

OLLAMA_URL = "http://localhost:11434/api/generate"
WORKER_URL = "https://thumbnail-board-api.andrei-nndd.workers.dev"

# ── Tag schema (must match server.py / Worker canonicaliseTags) ──────
CATS = {
    "STYLE":     ["colorful","high-contrast","minimal","split-screen","illustration",
                  "handdrawn","3d","photoshopped","collage","anatomy","busy","match-split",
                  "monochrome","pattern","dissolving","photo-composite"],
    "MOOD":      ["dramatic","happy","serious","entertaining","confused","exhausted",
                  "frustrated","sad","surprised","skeptical"],
    "TEXT":      ["identity","callout","question","normative-claim","number","quote",
                  "forward-referencing","cta","in-center","in-background","direct-address",
                  "chat","answer"],
    "ELEMENT":   ["celebrity","graphic","chart","unusual","glow","logo","screen","money",
                  "in-background","fire","hand","in-foreground","in-motion","obfuscation",
                  "eye","map","vehicle","pile","damage","animal","food","book","brain",
                  "crowd","emoji","notification","checkbox","review","building"],
    "CAMERA":    ["medium-shot","close-up","overhead-shot","full-shot","aerial-shot",
                  "back-shot","unusual"],
    "SUBJECT":   ["in-motion","holding-object","count-two","count-many","in-background",
                  "unusual-pose","talking","laying","sitting","clone"],
    "FORMATION": ["flat-lay","line","grid","v"],
    "TOPIC":     ["comparison","product-showcase","space","secret","social-media","size"],
    "CALLOUT":   ["magnifier"],
    "BACKDROP":  ["dark","light","blurry"],
}

def build_all_valid():
    """All valid tag strings from current CATS dict."""
    out = set()
    for cat, subs in CATS.items():
        for s in subs:
            out.add(f"{cat.lower()}-{s}")
    return out

def discover_custom_tags(board: list, feedback: list) -> int:
    """Mutates CATS to include any custom tags found in published board
    items or in recent human approvals. Returns count of new additions."""
    added = 0
    sources = list(board) + [{"tags": f.get("final_tags", [])} for f in feedback]
    for v in sources:
        for t in (v.get("tags") or []):
            dash = t.find("-")
            if dash < 1: continue
            cat = t[:dash].upper()
            sub = t[dash+1:]
            if cat not in CATS: continue
            if sub not in CATS[cat]:
                CATS[cat].append(sub)
                added += 1
    return added

ALL_VALID = build_all_valid()

# ── Helpers ──────────────────────────────────────────────────────────
def download_thumb_b64(video_id: str) -> str | None:
    """Returns base64-encoded JPEG of the YouTube thumbnail, or None."""
    for quality in ("maxresdefault", "mqdefault"):
        url = f"https://img.youtube.com/vi/{video_id}/{quality}.jpg"
        try:
            req = Request(url, headers={"User-Agent": "Mozilla/5.0"})
            with urlopen(req, timeout=10) as r:
                data = r.read()
            # YouTube returns a tiny placeholder grey image (~120x90) for missing
            if len(data) < 2000:
                continue
            return base64.b64encode(data).decode()
        except Exception:
            continue
    return None

def load_feedback() -> list:
    """Past entries with both AI suggestion and final human-approved tags."""
    if not FEEDBACK_FILE.exists(): return []
    try: return json.loads(FEEDBACK_FILE.read_text())
    except: return []

def looks_confident(tags: list, min_tags: int, max_tags: int) -> tuple[bool, str]:
    """Heuristic sanity check on AI output. Returns (ok, reason_if_not)."""
    if not tags:                       return False, "no tags"
    if len(tags) < min_tags:           return False, f"only {len(tags)} tags (min {min_tags})"
    if len(tags) > max_tags:           return False, f"too many ({len(tags)}, max {max_tags})"
    # Mandatory: at least one STYLE tag (every thumbnail has a style)
    if not any(t.startswith("style-") for t in tags):
        return False, "no style-* tag"
    return True, ""

def publish_to_worker(entry: dict, auth_token: str) -> tuple[bool, str]:
    """POST to /api/add. Returns (success, message)."""
    payload = json.dumps(entry).encode()
    req = Request(
        f"{WORKER_URL}/api/add",
        data=payload,
        headers={
            "Content-Type": "application/json",
            "X-Auth-Token": auth_token,
            "User-Agent": "ThumbnailBoardAutoTag/1.0",
        },
    )
    try:
        with urlopen(req, timeout=30) as r:
            resp = json.loads(r.read())
        if resp.get("ok"):
            return True, "published"
        msg = resp.get("msg", "")
        if "Already" in msg:
            return True, "already in board"
        return False, msg
    except Exception as e:
        return False, str(e)

def build_few_shot(board: list, k: int = 6) -> tuple[list, list]:
    """Build positive + corrective few-shot.
    Returns (positive_examples, correction_examples).
    - positive: recently approved (high signal) + random board fallback
    - correction: items where AI was wrong and user fixed them (most teaching)
    """
    feedback = load_feedback()
    # Prefer the most recent corrections (last 30) — those teach the most
    corrections = [f for f in feedback[-30:] if f.get("ai_tags") != f.get("final_tags")]
    # And the most recent approved items as "good" examples
    recent_good = [{"title": f.get("title",""), "tags": f.get("final_tags",[])}
                   for f in feedback[-20:]]

    if not recent_good:
        # Fallback to board entries when we have no feedback yet
        candidates = [v for v in board if 3 <= len(v.get("tags",[])) <= 10
                      and all(t in ALL_VALID for t in v.get("tags",[]))]
        random.shuffle(candidates)
        recent_good = candidates[:k]

    random.shuffle(recent_good)
    return recent_good[:k], corrections[-3:]  # 3 corrections is enough to nudge

PROMPT_TEMPLATE = """You are an expert at categorising YouTube thumbnails for a curated reference board.

You must pick tags from this fixed taxonomy. Tags are written as `category-subtag` and you may ONLY use these:

{taxonomy}

Rules:
- Output a JSON object with one key: "tags" (an array of strings).
- Each string MUST exactly match one from the list above (case-sensitive).
- Choose 3-8 tags total. Be selective: only tags that clearly apply.
- Do NOT invent new tags. Do NOT omit the category prefix.
- No other text outside the JSON.

Example output: {{"tags": ["style-colorful", "mood-dramatic", "text-number", "element-celebrity"]}}

Now classify this thumbnail."""

def build_taxonomy_str() -> str:
    out = []
    for cat, subs in CATS.items():
        out.append(f"  {cat.lower()}: " + ", ".join(f"{cat.lower()}-{s}" for s in subs))
    return "\n".join(out)

# Computed at runtime in main() AFTER discover_custom_tags
TAXONOMY_STR = ""

def call_ollama(model: str, image_b64: str, title: str,
                positive: list, corrections: list) -> list:
    """Call Ollama with the image + prompt. Returns list of tag strings."""
    # TAXONOMY_STR is mutated in main() once we've discovered custom tags
    prompt = PROMPT_TEMPLATE.format(taxonomy=TAXONOMY_STR)
    if title:
        prompt += f"\n\nVideo title (context): {title}"
    if positive:
        prompt += "\n\nReference (good examples from this board):"
        for ex in positive[:4]:
            prompt += f"\n  - \"{ex.get('title','')[:70]}\" → {ex.get('tags',[])}"
    if corrections:
        prompt += "\n\nIMPORTANT — past mistakes you must avoid:"
        for c in corrections:
            removed = [t for t in c.get("ai_tags", []) if t not in c.get("final_tags", [])]
            added   = [t for t in c.get("final_tags", []) if t not in c.get("ai_tags", [])]
            if removed or added:
                line = f"\n  - For \"{c.get('title','')[:60]}\":"
                if removed: line += f"\n      You picked {removed} but those were WRONG, the user removed them."
                if added:   line += f"\n      You missed {added} but those WERE correct."
                prompt += line

    payload = {
        "model": model,
        "prompt": prompt,
        "images": [image_b64],
        "stream": False,
        "format": "json",
        "options": {"temperature": 0.2}
    }
    body = json.dumps(payload).encode()
    req = Request(OLLAMA_URL, data=body, headers={"Content-Type":"application/json"})
    with urlopen(req, timeout=120) as r:
        resp = json.loads(r.read())
    raw = resp.get("response", "").strip()
    # Try to parse as JSON
    try:
        obj = json.loads(raw)
    except json.JSONDecodeError:
        # Sometimes model wraps in code fences
        m = re.search(r'\{.*\}', raw, re.DOTALL)
        if not m: return []
        try: obj = json.loads(m.group())
        except: return []
    raw_tags = obj.get("tags") if isinstance(obj, dict) else None
    if not isinstance(raw_tags, list): return []
    # Filter to valid taxonomy
    return [t for t in raw_tags if isinstance(t, str) and t in ALL_VALID]

# ── Main ─────────────────────────────────────────────────────────────
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--batch", type=int, default=10,
                    help="Process N items then stop (default 10). Use 0 for all.")
    ap.add_argument("--limit", type=int, default=0, help="Alias for --batch")
    ap.add_argument("--resume", action="store_true", default=True,
                    help="Skip items already in pending_review.json (default on)")
    ap.add_argument("--model", default="qwen2.5vl:7b")
    ap.add_argument("--auto-approve", action="store_true", dest="auto_approve",
                    help="Publish directly to the board if AI output passes sanity checks. "
                         "Items that fail checks still go to pending_review.json.")
    ap.add_argument("--min-tags", type=int, default=3,
                    help="Minimum tags for auto-approve (default 3)")
    ap.add_argument("--max-tags", type=int, default=10,
                    help="Maximum tags for auto-approve (default 10)")
    args = ap.parse_args()
    if args.limit and not args.batch:
        args.batch = args.limit

    auth_token = ""
    if args.auto_approve:
        auth_token = os.environ.get("TB_AUTH_TOKEN", "")
        if not auth_token:
            print("⚠ --auto-approve needs TB_AUTH_TOKEN env var:")
            print("   export TB_AUTH_TOKEN='91q9YY3Eqgp5xwbA9dlGZWeGjYOLr6FQXDRdSqpr1eo='")
            sys.exit(1)

    pending = json.loads(PENDING_FILE.read_text())
    board   = json.loads(BOARD_FILE.read_text())
    review  = json.loads(REVIEW_FILE.read_text()) if REVIEW_FILE.exists() else []
    skip    = set(json.loads(SKIP_FILE.read_text()) if SKIP_FILE.exists() else [])
    feedback = load_feedback()

    # Discover custom tags from data.json and previous feedback,
    # add them to the taxonomy so the AI knows they exist
    new_tags_added = discover_custom_tags(board, feedback)
    global ALL_VALID, TAXONOMY_STR
    ALL_VALID = build_all_valid()
    TAXONOMY_STR = build_taxonomy_str()
    if new_tags_added:
        print(f"📚 Discovered {new_tags_added} custom tags from board + feedback")

    # Also skip items already published (in data.json now)
    published = set(v["id"] for v in board)
    done_ids = set(r["id"] for r in review) | published
    todo = [p for p in pending if p["id"] not in done_ids and p["id"] not in skip]
    if args.batch > 0:
        todo = todo[:args.batch]

    print(f"📊 Total pending: {len([p for p in pending if p['id'] not in done_ids and p['id'] not in skip])}")
    print(f"   In queue for review: {len(review)} | Published: {len(published)} | Skipped: {len(skip)}")
    print(f"   Feedback entries (used for learning): {len(feedback)}")
    print(f"🤖 Model: {args.model}    Batch: {len(todo)}")
    print(f"📝 Output: {REVIEW_FILE.name}\n")

    t0 = time.time()
    fails = 0
    for i, item in enumerate(todo, 1):
        vid = item["id"]
        title = item.get("title","")
        elapsed = time.time() - t0
        rate = elapsed / max(i-1, 1)
        eta = rate * (len(todo) - i)
        print(f"[{i:4d}/{len(todo)}] {vid}  '{title[:60]}'  (eta {eta/60:.1f}min)", flush=True)

        img_b64 = download_thumb_b64(vid)
        if not img_b64:
            print(f"           ⚠ thumbnail not available (private/deleted) — skipping")
            skip.add(vid)
            SKIP_FILE.write_text(json.dumps(sorted(skip)))
            fails += 1
            continue

        positive, corrections = build_few_shot(board, k=6)
        try:
            tags = call_ollama(args.model, img_b64, title, positive, corrections)
        except Exception as e:
            print(f"           ❌ Ollama error: {e}")
            fails += 1
            continue

        if not tags:
            print(f"           ⚠ no valid tags returned — skipping")
            skip.add(vid)
            SKIP_FILE.write_text(json.dumps(sorted(skip)))
            fails += 1
            continue

        entry = {
            "id": vid,
            "eid": item.get("eid",""),
            "title": title,
            "channel": item.get("channel",""),
            "views": item.get("views",""),
            "tags": tags,
            "ai_tags": list(tags),
            "auto_tagged_at": int(time.time()),
        }

        if args.auto_approve:
            ok, reason = looks_confident(tags, args.min_tags, args.max_tags)
            if ok:
                published, msg = publish_to_worker(entry, auth_token)
                if published:
                    pub_log = json.loads(AUTO_PUBLISHED_FILE.read_text()) if AUTO_PUBLISHED_FILE.exists() else []
                    pub_log.append({**entry, "result": msg})
                    AUTO_PUBLISHED_FILE.write_text(json.dumps(pub_log, ensure_ascii=False, indent=2))
                    print(f"           🚀 auto-published: {tags}")
                    continue
                print(f"           ⚠ publish failed ({msg}) — queuing for review")
            else:
                print(f"           👀 needs human ({reason}) — queuing for review")
        # Append to pending_review.json — re-read from disk to avoid clobbering
        # concurrent removals by review.py.
        try:
            current = json.loads(REVIEW_FILE.read_text()) if REVIEW_FILE.exists() else []
        except Exception:
            current = []
        # Don't duplicate
        if not any(r.get("id") == entry["id"] for r in current):
            current.append(entry)
            REVIEW_FILE.write_text(json.dumps(current, ensure_ascii=False, indent=2))
        if not args.auto_approve:
            print(f"           ✓ {tags}")

    if args.auto_approve:
        pub_count = len(json.loads(AUTO_PUBLISHED_FILE.read_text())) if AUTO_PUBLISHED_FILE.exists() else 0
        print(f"\n✅ Batch done. {pub_count} total auto-published. {len(review)} need human review.")
        print(f"   Errors: {fails}")
        print(f"   Next: python3 review.py    # check the queued ones")
    else:
        print(f"\n✅ Batch done. {len(review)} items waiting in {REVIEW_FILE.name}")
        print(f"   Errors: {fails}")
        print(f"   Next:")
        print(f"     export TB_AUTH_TOKEN='91q9YY3Eqgp5xwbA9dlGZWeGjYOLr6FQXDRdSqpr1eo='")
        print(f"     python3 review.py     # review this batch")
        print(f"     python3 auto_tag.py   # next batch learns from your corrections")

if __name__ == "__main__":
    main()
