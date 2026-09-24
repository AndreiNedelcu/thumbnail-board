#!/usr/bin/env bash
# auto_tag_tick.sh — invoked by launchd every 10 minutes.
#
# Pulls the repo to pick up any inbox approvals from the web,
# then processes whatever is now pending in eagle-pending.json
# (auto_tag.py exits immediately when there's nothing to do).
#
# Differs from run_all.sh: foreground execution (launchd needs
# the process to exit when work is done), single-instance lock,
# silent on no-op, no "Started PID..." banner.
#
# Loaded by:
#   ~/Library/LaunchAgents/com.thumbnailboard.autotag.plist
# Manage with:
#   launchctl bootout  gui/$(id -u)/com.thumbnailboard.autotag    # stop
#   launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.thumbnailboard.autotag.plist  # (re)load
#   launchctl print gui/$(id -u)/com.thumbnailboard.autotag       # status
#   tail -f /tmp/tb-auto-tag.log

set -uo pipefail
cd "$(dirname "$0")"

LOG="/tmp/tb-auto-tag.log"
LOCK="/tmp/tb-auto-tag.lock"

# Single-instance guard — if a previous tick is still processing, just exit
if [ -f "$LOCK" ] && kill -0 "$(cat "$LOCK" 2>/dev/null)" 2>/dev/null; then
  echo "[$(date '+%F %T')] tick: previous run still active (pid $(cat "$LOCK")), skip" >> "$LOG"
  exit 0
fi
echo $$ > "$LOCK"
trap 'rm -f "$LOCK"' EXIT

# Auth token must be in env (launchd injects from the plist)
if [ -z "${TB_AUTH_TOKEN:-}" ]; then
  echo "[$(date '+%F %T')] tick: TB_AUTH_TOKEN not set, abort" >> "$LOG"
  exit 1
fi

# Pull latest so we see fresh inbox approvals
if ! git pull --rebase --autostash --quiet 2>>"$LOG"; then
  echo "[$(date '+%F %T')] tick: git pull failed, abort to avoid stale-data run" >> "$LOG"
  exit 1
fi

# Quick check: anything to do?
todo=$(python3 -c "
import json
from pathlib import Path
from board_data import load_board_file
pending = load_board_file(Path('eagle-pending.json'), '/api/pending')
board = load_board_file(Path('data.json'), '/api/data')
done = {v['id'] for v in board}
skip = set(json.loads(Path('auto_tag_skip.json').read_text())) if Path('auto_tag_skip.json').exists() else set()
print(sum(1 for p in pending if p['id'] not in done and p['id'] not in skip) + sum(1 for v in board if not v.get('tags') and v['id'] not in skip))
")
if [ "$todo" -eq 0 ]; then
  exit 0   # silent no-op; no log spam every 10 min
fi

echo "[$(date '+%F %T')] tick: processing $todo new pending items" >> "$LOG"
exec python3 auto_tag.py --batch 0 --publish-all >> "$LOG" 2>&1
