#!/usr/bin/env bash
# Process the entire Eagle backlog in background with auto-approve.
# Items that pass the sanity filter (3-10 tags, has style-*, etc.) get
# published directly. Items that fail land in pending_review.json for
# manual review later.
#
# Usage:
#   ./run_all.sh             # processes everything pending
#   ./run_all.sh --strict    # tighter filter: 4-8 tags
#   ./run_all.sh log         # tail the log of a current run

set -euo pipefail
cd "$(dirname "$0")"

LOG="/tmp/tb-auto-tag.log"

if [ "${1:-}" = "log" ]; then
  echo "Tailing $LOG (Ctrl+C to stop watching, the run keeps going):"
  tail -f "$LOG"
  exit 0
fi

if [ "${1:-}" = "stop" ]; then
  pkill -f "auto_tag.py.*--auto-approve" 2>/dev/null && echo "Stopped." || echo "Nothing to stop."
  exit 0
fi

# Ensure token is set
: "${TB_AUTH_TOKEN:?Set TB_AUTH_TOKEN env var first}"

# Sanity filter
MIN=3
MAX=10
if [ "${1:-}" = "--strict" ]; then MIN=4; MAX=8; fi

echo "▶ Starting auto-tag run (auto-approve, min $MIN, max $MAX tags)"
echo "  Log: $LOG"
echo "  Stop with: ./run_all.sh stop"
echo "  Watch:    ./run_all.sh log"
echo ""

nohup python3 auto_tag.py --batch 0 --auto-approve --min-tags "$MIN" --max-tags "$MAX" \
  > "$LOG" 2>&1 &
PID=$!
echo "Started (PID $PID). It will run until eagle-pending.json is empty."
echo "Approximate time: ~10s per item × ~1200 items = ~3 hours."
