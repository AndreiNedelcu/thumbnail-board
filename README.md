# Thumbnail Board

Visual reference board for YouTube thumbnails — built for **@therealseniordev** and **@theSeniorDevPodcast**, with curated picks from the wider tech / dev / design space.

**Live site:** https://andreinedelcu.github.io/thumbnail-board
**Worker API:** https://thumbnail-board-api.andrei-nndd.workers.dev

## Features
- ~1.7k thumbnails (and growing via the auto-tagger)
- Real-time search by tag, title or channel
- Filter by category (STYLE, MOOD, TEXT, ELEMENT, …)
- Sort by Default / Recent / Views, plus Shuffle and bulk Select
- Lightbox with full-size image, inline tag editor, deep-linkable via `#v=<videoId>`
- Chrome/Arc extension to save thumbnails from YouTube with one click (uses local Ollama for tag suggestions)
- Cloudflare Worker writes back to `data.json` on GitHub → GitHub Pages rebuilds

## Architecture & onboarding
See **`ONBOARDING.md`** for the current architecture, key files, Worker endpoints, data schema, tag taxonomy, and how to run the auto-tagger, scraper, and view backfill.

## Related docs
- `ONBOARDING.md` — start here
- `AUTO_TAG.md` — auto-tag workflow with incremental learning
- `SCRAPE.md` — YouTube niche scraping & curation
- `MIGRATION.md` — historical playbook for redeploying the Worker
