#!/usr/bin/env python3
"""
whisper_transcripts.py — for each video in data.json without a
transcript on disk, download the audio with yt-dlp and transcribe it
locally using whisper.cpp (large-v3-turbo via Metal on M1). Writes the
plain-text transcript to transcripts/{id}.txt — same shape as
extract_transcripts.py output, so summarize.py picks them up later.

One worker at a time — the model takes the whole Apple GPU.

Usage:
  python3 whisper_transcripts.py             # everything missing
  python3 whisper_transcripts.py --limit 20  # quick test on 20 vids
"""
import argparse
import json
import os
import subprocess
import sys
import time
import tempfile
from pathlib import Path

ROOT          = Path(__file__).parent
DATA          = ROOT / "data.json"
OUT_DIR       = ROOT / "transcripts"
MODEL_PATH    = ROOT / "models" / "ggml-large-v3-turbo.bin"
WHISPER_BIN   = "whisper-cli"
TMP_AUDIO_DIR = Path("/tmp/tb-whisper-audio")

# yt-dlp args — download audio only as wav 16kHz mono (what whisper.cpp wants)
def download_audio(vid, audio_path):
    cmd = [
        "yt-dlp",
        "--cookies-from-browser", "chrome",
        "-f", "bestaudio",
        "-x", "--audio-format", "wav", "--audio-quality", "0",
        "--postprocessor-args", "ffmpeg:-ar 16000 -ac 1",
        "--no-warnings", "--no-playlist", "--no-progress",
        "-o", str(audio_path).replace('.wav', '.%(ext)s'),
        f"https://www.youtube.com/watch?v={vid}",
    ]
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=300)
    return r.returncode == 0, r.stderr[:200]

def transcribe(audio_path, txt_path):
    # whisper-cli reads .wav, writes <audio>.txt (without .txt suffix in -of)
    cmd = [
        WHISPER_BIN,
        "-m", str(MODEL_PATH),
        "-f", str(audio_path),
        "--output-txt",
        "--no-prints",
        "--language", "auto",
        "-of", str(audio_path.with_suffix('')),    # output base name
    ]
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=900)
    if r.returncode != 0:
        return False, r.stderr[:200]
    produced = audio_path.with_suffix('.txt')
    if not produced.exists() or produced.stat().st_size < 50:
        return False, "whisper produced empty output"
    text = produced.read_text().strip()
    txt_path.write_text(text)
    produced.unlink(missing_ok=True)
    return True, ""

def process_one(vid):
    txt_path = OUT_DIR / f"{vid}.txt"
    if txt_path.exists() and txt_path.stat().st_size > 50:
        return {"id": vid, "status": "already"}

    TMP_AUDIO_DIR.mkdir(exist_ok=True)
    audio_path = TMP_AUDIO_DIR / f"{vid}.wav"

    try:
        ok, err = download_audio(vid, audio_path)
        if not ok:
            return {"id": vid, "status": "ytdlp-failed", "error": err}
        if not audio_path.exists():
            # yt-dlp might've used a different extension; find it
            cands = list(TMP_AUDIO_DIR.glob(f"{vid}.*"))
            if not cands: return {"id": vid, "status": "no-audio-file"}
            audio_path = cands[0]

        ok, err = transcribe(audio_path, txt_path)
        if not ok:
            return {"id": vid, "status": "whisper-failed", "error": err}
        return {"id": vid, "status": "ok", "chars": txt_path.stat().st_size}
    finally:
        # cleanup
        for f in TMP_AUDIO_DIR.glob(f"{vid}.*"):
            f.unlink(missing_ok=True)

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, help="Stop after N videos (for testing)")
    ap.add_argument("--ids", help="Comma-separated IDs to process (overrides discovery)")
    args = ap.parse_args()

    if not MODEL_PATH.exists():
        print(f"ERROR: model not found at {MODEL_PATH}", file=sys.stderr)
        sys.exit(1)

    OUT_DIR.mkdir(exist_ok=True)

    if args.ids:
        ids = [s.strip() for s in args.ids.split(",") if s.strip()]
    else:
        data = json.loads(DATA.read_text())
        existing = {p.stem for p in OUT_DIR.glob("*.txt")}
        ids = [v["id"] for v in data if v["id"] not in existing]

    if args.limit:
        ids = ids[:args.limit]

    print(f"Whisper-transcribing {len(ids)} videos with model {MODEL_PATH.name}")
    print(f"Output: {OUT_DIR}/  ·  serial (1 worker, GPU exclusive)\n")

    started = time.time()
    results = []
    for i, vid in enumerate(ids, 1):
        t0 = time.time()
        r = process_one(vid)
        elapsed = time.time() - started
        eta = (len(ids) - i) * elapsed / i if i else 0
        marker = "✓" if r["status"] == "ok" else "○" if r["status"] == "already" else "✗"
        dt = time.time() - t0
        print(f"  [{i:>3}/{len(ids)}] {marker} {vid}  {r['status']:<18} {dt:>4.0f}s   elapsed {elapsed/60:.1f}m  eta {eta/60:.1f}m", flush=True)
        results.append(r)

    by_status = {}
    for r in results:
        by_status[r["status"]] = by_status.get(r["status"], 0) + 1
    print(f"\n=== Done in {(time.time()-started)/60:.1f} min ===")
    for s, n in sorted(by_status.items(), key=lambda kv: -kv[1]):
        print(f"  {s:<25} {n}")

if __name__ == "__main__":
    main()
