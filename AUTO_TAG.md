# Auto-tag workflow (incremental learning)

The model gets **better with each batch** because your corrections become its training examples.

## The loop

```
┌────────────┐    ┌──────────────┐    ┌────────────────────────┐
│ auto_tag   │ →  │  review.py   │ →  │ auto_tag_feedback.json │
│ batch 10   │    │ approve/edit │    │ (AI said X, you fixed Y)│
└────────────┘    └──────────────┘    └────────────────────────┘
       ↑                                          │
       └──── next batch reads feedback ───────────┘
              and learns from your corrections
```

## How to run

**One-time setup:**
```bash
export TB_AUTH_TOKEN='91q9YY3Eqgp5xwbA9dlGZWeGjYOLr6FQXDRdSqpr1eo='
```
(or put it in your `~/.zshrc`)

**The actual loop:**
```bash
# Round 1 — first 10 items
python3 auto_tag.py            # processes 10 items (~2 min)
python3 review.py              # opens browser, you review/approve/reject these 10
                               # (close the browser when done — Ctrl+C in terminal)

# Round 2 — next 10, AI sees your past corrections
python3 auto_tag.py            # processes next 10 (~2 min)
python3 review.py              # review

# … repeat until pending_review.json is empty
```

Each `python3 auto_tag.py` call grabs the next batch (skipping already published).
Each `python3 review.py` session writes to `auto_tag_feedback.json`.
Next round's prompt includes "past mistakes you must avoid" with your fixes.

## What gets recorded as feedback

| Action | What's saved |
|---|---|
| Approve without edits | "AI got it perfect" — positive reinforcement |
| Approve after editing tags | Both old + new tags — diff teaches the model |
| Reject | "These tags weren't good enough overall" |
| Skip | Nothing (decide later) |

## Tuning the batch size

- `python3 auto_tag.py` defaults to **10 items**
- Want bigger? `python3 auto_tag.py --batch 50` (faster but less learning per round)
- Want all at once? `python3 auto_tag.py --batch 0` (no learning loop, just blast)
- Recommended: start with 10, expand to 25-50 once you trust the model

## When to fully automate

After ~30 manually-reviewed items, the model has enough feedback to be trusted on
items where its output looks reasonable. Three escalation tiers:

**Tier 1 — Approve-all in review.html**
Run `auto_tag.py --batch 50` (or higher), open `review.py`, scan quickly, then
click "Approve all remaining" once you're confident the queue is fine.

**Tier 2 — Auto-approve flag**
Skip the review queue entirely for items that pass a sanity filter:
```bash
export TB_AUTH_TOKEN='91q9YY3Eqgp5xwbA9dlGZWeGjYOLr6FQXDRdSqpr1eo='
python3 auto_tag.py --batch 50 --auto-approve
```
Items with 3-10 valid tags and at least one `style-*` go straight to the board.
Anything that fails the check still queues for review.

**Tier 3 — Full background run**
For the entire backlog at once:
```bash
export TB_AUTH_TOKEN='91q9YY3Eqgp5xwbA9dlGZWeGjYOLr6FQXDRdSqpr1eo='
./run_all.sh          # runs in background, logs to /tmp/tb-auto-tag.log
./run_all.sh log      # watch progress
./run_all.sh stop     # stop the run
./run_all.sh --strict # tighter filter (4-8 tags) for safer auto-approve
```
Add `--strict` if you want only the cleanest auto-approves and prefer to review
borderline cases later.

## State files

- `pending_review.json`    queue waiting for human review (built by auto_tag.py)
- `pending_rejected.json`  rejected entries (for forensic analysis)
- `auto_tag_feedback.json` the learning corpus (read by next auto_tag run)
- `auto_tag_skip.json`     videos that can't be processed (deleted/private)

These are NOT committed — they're local working files.

## Reset

To start fresh:
```bash
rm pending_review.json auto_tag_feedback.json auto_tag_skip.json pending_rejected.json
```
