#!/usr/bin/env python3
"""
recover_vtts.py — sweep transcripts/ for any .vtt files left over by a
failed extract run, convert them to plain-text {id}.txt (preferring
en-orig > en > en-en > es), and delete the .vtt files.

Use this once after a partial extract failure to avoid re-downloading.
"""
import re
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).parent
OUT_DIR = ROOT / "transcripts"

LANG_PRIORITY = ["en-orig", "en-US", "en-GB", "en", "en-en", "es-419", "es-US", "es", "es-es"]

def vtt_to_plain(vtt_text):
    out = []
    for raw in vtt_text.split("\n"):
        line = raw.strip()
        if not line: continue
        if line.startswith("WEBVTT"): continue
        if line.startswith("Kind:") or line.startswith("Language:"): continue
        if "-->" in line: continue
        if re.match(r"^\d+$", line): continue
        line = re.sub(r"<[^>]+>", "", line)
        line = re.sub(r"&nbsp;|&amp;", " ", line)
        out.append(line)
    deduped = []
    for line in out:
        if not deduped or deduped[-1] != line:
            deduped.append(line)
    return " ".join(deduped).strip()

def main():
    if not OUT_DIR.exists():
        print("No transcripts/ directory")
        return

    # Group .vtt files by video id (filename stem before the last .{lang})
    by_id = defaultdict(list)
    for f in OUT_DIR.glob("*.vtt"):
        # filename format: {id}.{lang}.vtt    e.g. abc123.en.vtt, abc123.en-orig.vtt
        stem = f.stem  # "abc123.en" or "abc123.en-orig"
        parts = stem.rsplit(".", 1)
        if len(parts) != 2:
            print(f"  ⚠ skip odd filename: {f.name}")
            continue
        vid, lang = parts
        by_id[vid].append((lang, f))

    print(f"Found .vtt files for {len(by_id)} video IDs")
    recovered, already_txt, failed = 0, 0, 0
    vtt_count = 0

    for vid, vtts in by_id.items():
        txt_path = OUT_DIR / f"{vid}.txt"
        if txt_path.exists() and txt_path.stat().st_size > 50:
            # already converted previously
            for _, f in vtts: f.unlink(missing_ok=True); vtt_count += 1
            already_txt += 1
            continue

        # Pick the best language variant
        def rank(lang):
            return LANG_PRIORITY.index(lang) if lang in LANG_PRIORITY else len(LANG_PRIORITY)
        vtts.sort(key=lambda lf: rank(lf[0]))
        chosen_lang, chosen_file = vtts[0]

        try:
            text = vtt_to_plain(chosen_file.read_text())
            if not text or len(text) < 100:
                print(f"  ⚠ {vid}: vtt parsed empty/too-short (lang={chosen_lang})")
                failed += 1
            else:
                txt_path.write_text(text)
                recovered += 1
        except Exception as e:
            print(f"  ⚠ {vid}: {e}")
            failed += 1

        # Clean up all vtt variants
        for _, f in vtts:
            f.unlink(missing_ok=True)
            vtt_count += 1

    print(f"\n=== Recovery done ===")
    print(f"  .vtt files swept:    {vtt_count}")
    print(f"  .txt newly created:  {recovered}")
    print(f"  .txt already there:  {already_txt}")
    print(f"  failed:              {failed}")

    final = list(OUT_DIR.glob("*.txt"))
    print(f"\n  total .txt in transcripts/: {len(final)}")

if __name__ == "__main__":
    main()
