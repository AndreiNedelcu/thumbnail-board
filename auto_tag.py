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
import argparse, base64, json, random, re, sys, time
from pathlib import Path
from urllib.request import urlopen, Request

ROOT = Path(__file__).parent
PENDING_FILE   = ROOT / "eagle-pending.json"
BOARD_FILE     = ROOT / "data.json"
REVIEW_FILE    = ROOT / "pending_review.json"
SKIP_FILE      = ROOT / "auto_tag_skip.json"  # ids we permanently couldn't process

OLLAMA_URL = "http://localhost:11434/api/generate"

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

ALL_VALID = set()
for cat, subs in CATS.items():
    for s in subs:
        ALL_VALID.add(f"{cat.lower()}-{s}")

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

def build_few_shot(board: list, k: int = 6) -> list:
    """Pick k well-tagged board entries with thumbnails as in-context examples."""
    # Bias toward items with 4-10 official tags (good signal, not over-tagged)
    candidates = [v for v in board if 3 <= len(v.get("tags",[])) <= 10
                  and all(t in ALL_VALID for t in v.get("tags",[]))]
    random.shuffle(candidates)
    return candidates[:k]

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

TAXONOMY_STR = build_taxonomy_str()

def call_ollama(model: str, image_b64: str, title: str, few_shot: list) -> list:
    """Call Ollama with the image + prompt. Returns list of tag strings."""
    # Build a compact message — Qwen2.5-VL handles images well via the images field
    prompt = PROMPT_TEMPLATE.format(taxonomy=TAXONOMY_STR)
    if title:
        prompt += f"\n\nVideo title (context): {title}"
    if few_shot:
        prompt += "\n\nReference examples from this exact board (titles + final tags):"
        for ex in few_shot[:4]:  # short
            prompt += f"\n  - \"{ex.get('title','')[:70]}\" → {ex.get('tags',[])}"

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
    ap.add_argument("--limit", type=int, default=0, help="Process only first N (0 = all)")
    ap.add_argument("--resume", action="store_true", help="Skip items already in pending_review.json")
    ap.add_argument("--model", default="qwen2.5vl:7b")
    args = ap.parse_args()

    pending = json.loads(PENDING_FILE.read_text())
    board   = json.loads(BOARD_FILE.read_text())
    review  = json.loads(REVIEW_FILE.read_text()) if REVIEW_FILE.exists() else []
    skip    = set(json.loads(SKIP_FILE.read_text()) if SKIP_FILE.exists() else [])

    done_ids = set(r["id"] for r in review) if args.resume else set()
    todo = [p for p in pending if p["id"] not in done_ids and p["id"] not in skip]
    if args.limit > 0:
        todo = todo[:args.limit]

    print(f"📊 Pending total: {len(pending)} | already reviewed: {len(done_ids)} | skipped: {len(skip)} | to do now: {len(todo)}")
    print(f"🤖 Model: {args.model}")
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

        few = build_few_shot(board, k=6)
        try:
            tags = call_ollama(args.model, img_b64, title, few)
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
            "auto_tagged_at": int(time.time()),
        }
        review.append(entry)
        REVIEW_FILE.write_text(json.dumps(review, ensure_ascii=False, indent=2))
        print(f"           ✓ {tags}")

    print(f"\n✅ Done. {len(review)} items in {REVIEW_FILE.name} ready for human review")
    print(f"   Errors: {fails}")
    print(f"   Next: python3 review.py")

if __name__ == "__main__":
    main()
