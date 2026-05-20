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

# Pull latest before reading eagle-pending.json. The Worker mutates
# this file remotely (via /api/inbox/approve), so the local copy can
# go stale between approves — auto_tag.py would see "Total pending: 0"
# and exit immediately. Pull silently; on conflict, abort so the user
# can resolve manually rather than running on stale data.
echo "🔄 git pull --rebase --autostash"
if ! git pull --rebase --autostash --quiet; then
  echo "❌ git pull failed — refusing to run auto_tag on stale eagle-pending.json"
  echo "   Resolve the git state, then re-run ./run_all.sh"
  exit 1
fi

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
