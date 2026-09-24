#!/usr/bin/env python3
"""THE-61: evaluate Ollama + Jev on a small sample before using it for review.

Read-only: it reads the board/inbox and writes a private report under
.local/jev-eval/; it never saves tags, scores or decisions to the board.

  python3 tools/jev-eval.py --limit 10                 # board sample, Saved vs others
  python3 tools/jev-eval.py --source inbox --limit 10  # new candidates, human-judged

Board items already carry human-approved tags, so tag precision/recall is measured
against them. With TB_AUTH_TOKEN set, the board sample is half Saved and half not:
if Jev's visual score does not separate them, it is not predicting our taste.
Needs TYPESAFE_API_KEY and a local Ollama vision model. Jev only sees Ollama's
text description, never the image itself.
"""
import argparse
import html
import json
import os
import random
import sys
import time
from pathlib import Path
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

# Published Jev price (September 2026): $0.042 per million input tokens, output free.
USD_PER_INPUT_TOKEN = 0.042 / 1_000_000


def get_json(api, path, token=""):
    headers = {"User-Agent": "ThumbnailBoard/2.0", **({"X-Auth-Token": token} if token else {})}
    with urlopen(Request(api + path, headers=headers), timeout=30) as response:
        return json.load(response)


def taxonomy_tags(tags, taxonomy):
    """Human tags Jev could have predicted: visual taxonomy only, no channel tags."""
    return {t for t in tags or [] if t in taxonomy and not t.startswith("channel-")}


def sample(items, limit, saved_ids, seed):
    rng = random.Random(seed)
    items = [v for v in items if v.get("id")]
    if not saved_ids:
        return rng.sample(items, min(limit, len(items)))
    saved = [v for v in items if v["id"] in saved_ids]
    other = [v for v in items if v["id"] not in saved_ids]
    half = min(len(saved), limit // 2)
    picked = rng.sample(saved, half) + rng.sample(other, min(len(other), limit - half))
    rng.shuffle(picked)
    return picked


def compare(item, result, taxonomy, saved_ids):
    human = taxonomy_tags(item.get("tags"), taxonomy)
    suggested = set(result.get("tags") or [])
    row = {
        "id": item["id"], "title": item.get("title", ""), "channel": item.get("channel", ""),
        "image": item.get("thumbnailUrl") or f"https://i.ytimg.com/vi/{item['id']}/hqdefault.jpg",
        "saved": item["id"] in saved_ids, "suggested": sorted(suggested),
        "uncertain": result.get("uncertain_tags", []), "visual_quality": result.get("visual_quality"),
        "visual_confidence": result.get("visual_confidence"), "observations": result.get("visual_observations", ""),
        "input_tokens": result.get("jev_input_tokens", 0),
    }
    if human:
        row.update(human=sorted(human), matched=sorted(human & suggested),
                   extra=sorted(suggested - human), missed=sorted(human - suggested))
    return row


def summarize(rows):
    judged = [r for r in rows if "human" in r]
    tp = sum(len(r["matched"]) for r in judged)
    fp = sum(len(r["extra"]) for r in judged)
    fn = sum(len(r["missed"]) for r in judged)
    def mean(values):
        values = [v for v in values if isinstance(v, (int, float))]
        return round(sum(values) / len(values), 2) if values else None
    def counts(key):
        out = {}
        for r in judged:
            for t in r[key]:
                out[t] = out.get(t, 0) + 1
        return dict(sorted(out.items(), key=lambda kv: -kv[1])[:10])
    tokens = sum(r["input_tokens"] for r in rows)
    return {
        "items": len(rows), "with_human_tags": len(judged),
        "precision": round(tp / (tp + fp), 3) if tp + fp else None,
        "recall": round(tp / (tp + fn), 3) if tp + fn else None,
        "most_extra_tags": counts("extra"), "most_missed_tags": counts("missed"),
        "visual_quality_saved": mean(r["visual_quality"] for r in rows if r["saved"]),
        "visual_quality_other": mean(r["visual_quality"] for r in rows if not r["saved"]),
        "jev_input_tokens": tokens, "estimated_usd": round(tokens * USD_PER_INPUT_TOKEN, 5),
    }


def render_html(report):
    esc = lambda v: html.escape(str(v))
    chips = lambda tags, cls: "".join(f'<span class="{cls}">{esc(t)}</span>' for t in tags)
    cards = []
    for r in report["rows"]:
        tags = (chips(r["matched"], "ok") + chips(r["extra"], "extra") + chips(r["missed"], "missed")) if "human" in r else chips(r["suggested"], "extra")
        score = "—" if r["visual_quality"] is None else f'{r["visual_quality"]:.2f}/4 (conf. {r["visual_confidence"] or 0:.2f})'
        cards.append(f'''<article><img src="{esc(r["image"])}" alt="" loading="lazy">
<h2>{esc(r["title"])}</h2><p class="meta">{esc(r["channel"])} · {esc(r["id"])}{" · ★ Saved" if r["saved"] else ""}</p>
<p><b>Visual:</b> {esc(score)}</p><p>{tags}</p>
<details><summary>Ollama observations</summary><p>{esc(r["observations"])}</p></details></article>''')
    s = report["summary"]
    return f'''<!doctype html><html lang="es"><meta charset="utf-8"><title>Jev evaluation</title>
<style>body{{font:14px system-ui;margin:16px;background:#111;color:#eee}}main{{display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:16px}}
article{{background:#1d1d1d;border-radius:8px;padding:12px}}img{{width:100%;border-radius:6px}}h2{{font-size:15px;margin:8px 0 2px}}.meta{{color:#999;margin:0}}
span{{display:inline-block;border-radius:4px;padding:1px 6px;margin:2px;font-size:12px}}.ok{{background:#1b5e20}}.extra{{background:#8a5a00}}.missed{{background:#7f1d1d;text-decoration:line-through}}</style>
<h1>Jev evaluation · {esc(report["source"])} · {esc(report["created_at"])}</h1>
<p>Suggestions only; nothing was written to the board. Green = matches approved tag, amber = suggested but not approved, red = approved but missed.</p>
<pre>{esc(json.dumps(s, indent=2, ensure_ascii=False))}</pre><main>{"".join(cards)}</main></html>'''


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--source", choices=["board", "inbox"], default="board")
    ap.add_argument("--limit", type=int, default=10)
    ap.add_argument("--model", default="qwen2.5vl:7b")
    ap.add_argument("--threshold", type=float, default=0.8)
    ap.add_argument("--seed", type=int, default=61)
    args = ap.parse_args()
    if not os.environ.get("TYPESAFE_API_KEY"):
        ap.error("Set TYPESAFE_API_KEY in your private environment (never in git).")
    if not 1 <= args.limit <= 50:
        ap.error("Keep the evaluation sample small: 1–50 items.")

    import auto_tag
    from jev_tagger import analyze_thumbnail
    api = os.environ.get("TB_API_URL", auto_tag.WORKER_URL).rstrip("/")
    token = os.environ.get("TB_AUTH_TOKEN", "")
    board = get_json(api, "/api/data")
    auto_tag.discover_custom_tags(board, [])
    taxonomy = {t for t in auto_tag.build_all_valid() if not t.startswith("channel-")}
    items = board if args.source == "board" else get_json(api, "/api/inbox")
    saved_ids = set(get_json(api, "/api/favorites", token).get("ids", [])) if token else set()
    if args.source == "board" and not saved_ids:
        print("Note: without TB_AUTH_TOKEN the sample is not split by Saved.")

    rows = []
    for i, item in enumerate(sample(items, args.limit, saved_ids if args.source == "board" else set(), args.seed), 1):
        print(f"[{i}/{args.limit}] {item['id']} {item.get('title', '')[:60]}", flush=True)
        image = auto_tag.download_thumb_b64(item["id"], item.get("thumbnailUrl", ""))
        if not image:
            print("   image unavailable, skipped")
            continue
        try:
            result = analyze_thumbnail(image, taxonomy, args.model, args.threshold)
        except Exception as error:
            print(f"   failed: {error}", file=sys.stderr)
            continue
        rows.append(compare(item, result, taxonomy, saved_ids))

    stamp = time.strftime("%Y%m%d-%H%M%S")
    report = {"source": args.source, "created_at": stamp, "model": args.model, "threshold": args.threshold,
              "summary": summarize(rows), "rows": rows}
    out = ROOT / ".local" / "jev-eval" / stamp
    out.mkdir(parents=True, exist_ok=True)
    (out / "report.json").write_text(json.dumps(report, indent=2, ensure_ascii=False))
    (out / "report.html").write_text(render_html(report))
    print(json.dumps(report["summary"], indent=2, ensure_ascii=False))
    print(f"\nOpen {out / 'report.html'} to review. Nothing was written to the board.")


if __name__ == "__main__":
    main()
