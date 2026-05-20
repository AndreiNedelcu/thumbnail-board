#!/usr/bin/env bash
# index_tick.sh — invoked by launchd every 15 minutes.
#
# Picks up any board items that don't yet have a Vectorize entry and
# runs the full ideas pipeline on them:
#   1. git pull (so we see anything auto_tag.py or the inbox approved)
#   2. extract_transcripts.py (yt-dlp captions for missing transcripts)
#   3. whisper_transcripts.py (Whisper local for ones without captions)
#   4. summarize.py (Claude Haiku → 200-word summary)
#   5. build_embeddings.py (CF Workers AI → Vectorize upsert)
#   6. commit + push the new summaries / manifest
#
# Loaded by:
#   ~/Library/LaunchAgents/com.thumbnailboard.indexer.plist
# Manage:
#   launchctl bootout  gui/$(id -u)/com.thumbnailboard.indexer
#   launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.thumbnailboard.indexer.plist
#   tail -f /tmp/tb-index.log

set -uo pipefail
cd "$(dirname "$0")"

LOG="/tmp/tb-index.log"
LOCK="/tmp/tb-index.lock"

# Single-instance guard
if [ -f "$LOCK" ] && kill -0 "$(cat "$LOCK" 2>/dev/null)" 2>/dev/null; then
  echo "[$(date '+%F %T')] tick: previous run still active, skip" >> "$LOG"
  exit 0
fi
echo $$ > "$LOCK"
trap 'rm -f "$LOCK"' EXIT

# Auth must be in env (set by the plist)
if [ -z "${TB_AUTH_TOKEN:-}" ] || [ -z "${ANTHROPIC_API_KEY:-}" ]; then
  echo "[$(date '+%F %T')] tick: missing TB_AUTH_TOKEN or ANTHROPIC_API_KEY, abort" >> "$LOG"
  exit 1
fi

# Pull latest data.json so we see new approvals/extension saves
if ! git pull --rebase --autostash --quiet 2>>"$LOG"; then
  echo "[$(date '+%F %T')] tick: git pull failed, abort" >> "$LOG"
  exit 1
fi

# How many videos still need an embedding?
NEW=$(python3 -c "
import json
from pathlib import Path
ROOT = Path('.')
data = json.loads((ROOT/'data.json').read_text())
embedded = set(json.loads((ROOT/'embedded.json').read_text())) if (ROOT/'embedded.json').exists() else set()
print(sum(1 for v in data if v['id'] not in embedded))
")

if [ "$NEW" -eq 0 ]; then
  exit 0   # nothing to do, silent
fi

echo "[$(date '+%F %T')] tick: $NEW items need indexing" >> "$LOG"

# 1) Try YouTube auto-captions for any missing transcript.
#    Skip if another extract is currently running (e.g. from a manual run).
if ! pgrep -f "extract_transcripts.py" > /dev/null; then
  python3 extract_transcripts.py --all >> "$LOG" 2>&1 || true
else
  echo "[$(date '+%F %T')] tick: extract_transcripts.py already running, skipping" >> "$LOG"
fi

# 2) For whatever's still missing a transcript, fall back to local Whisper.
#    Skip if whisper is already in flight from a previous run / manual launch.
if command -v whisper-cli >/dev/null && [ -f models/ggml-large-v3-turbo.bin ]; then
  if pgrep -f "whisper_transcripts.py" > /dev/null; then
    echo "[$(date '+%F %T')] tick: whisper_transcripts.py already running, skipping" >> "$LOG"
  else
    STILL_MISSING=$(python3 -c "
import json
from pathlib import Path
ROOT = Path('.')
data = json.loads((ROOT/'data.json').read_text())
existing = {p.stem for p in (ROOT/'transcripts').glob('*.txt')}
print(sum(1 for v in data if v['id'] not in existing))
")
    if [ "$STILL_MISSING" -gt 0 ]; then
      echo "[$(date '+%F %T')] tick: $STILL_MISSING vids still missing transcript, trying Whisper" >> "$LOG"
      python3 whisper_transcripts.py >> "$LOG" 2>&1 || true
    fi
  fi
fi

# 3) Summarize whatever's new (skip if another summarize is in flight)
if ! pgrep -f "summarize.py" > /dev/null; then
  python3 summarize.py >> "$LOG" 2>&1 || true
else
  echo "[$(date '+%F %T')] tick: summarize.py already running, skipping" >> "$LOG"
fi

# 4) Embed whatever's new (manifest skips done IDs)
if ! pgrep -f "build_embeddings.py" > /dev/null; then
  python3 build_embeddings.py >> "$LOG" 2>&1 || true
else
  echo "[$(date '+%F %T')] tick: build_embeddings.py already running, skipping" >> "$LOG"
fi

# 5) Commit + push the new summaries and updated manifest
if ! git diff --quiet summaries/ embedded.json; then
  git add summaries/ embedded.json
  git commit -m "data: auto-index $NEW new items via index_tick" --quiet >> "$LOG" 2>&1
  git push --quiet >> "$LOG" 2>&1 && echo "[$(date '+%F %T')] tick: pushed new summaries" >> "$LOG"
fi

FINAL_EMBEDDED=$(python3 -c "import json; print(len(json.load(open('embedded.json'))))")
echo "[$(date '+%F %T')] tick: board done, manifest now $FINAL_EMBEDDED entries" >> "$LOG"

# 6) Enrich the discovery index — for every item the Worker added to
#    discovery_queue.json, pull its transcript locally (reuse the same
#    transcripts/ folder) and POST it to /api/ideas/discovery-enrich so
#    the lightweight embed gets upgraded to a transcript-grade one.
python3 enrich_discovery.py >> "$LOG" 2>&1 || true
