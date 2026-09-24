# Thumbnail Board → Supabase

The frontend stays on GitHub Pages. Supabase replaces the Cloudflare Worker,
GitHub Contents writes, Vectorize and remote image URLs as the only image source.
The local preview has its own Postgres database; it never edits the original JSON
files or the production board.

## Deployment status — 23 September 2026

Supabase project `zdodflwtphnzvfkuarmn` is deployed in `eu-central-1`:
https://supabase.com/dashboard/project/zdodflwtphnzvfkuarmn

- 2,672 original records imported without replacing the source Git snapshot.
- All 2,163 board thumbnails archived independently of YouTube, plus 105 pending/inbox
  images. Three unavailable YouTube images were recovered from the original Eagle library.
- All missing channel names recovered: 1,220 through YouTube and 13 from Eagle.
  Every board record now has a channel and an archived image.
- Live single/bulk deletion, Saved and authorization checks passed. The deletion
  smoke test used disposable fixtures and left the user's collection unchanged.
- Image/metadata maintenance runs each minute. Discovery runs every six hours; its live test added 10 candidates from 9 channels.
  It uses the existing YouTube Data API key stored as a Supabase secret.
- Published at https://andreinedelcu.github.io/thumbnail-board/ and verified against
  live Supabase images. The old Cloudflare cron, production URL and preview URLs
  are disabled; both old URL types returned 404. Its source and indexes remain
  available for rollback, with no active board traffic.
- All 2,163 board records are indexed in pgvector; the discovery index has 129
  records after the initial collection run. English semantic queries were relevant;
  the Spanish sample was less precise (THE-63).
- Jev integration is optional and awaits a TypeSafe API key and real-sample validation
  (THE-61). It is not enabled in production.

Private migration credentials live in `.env.migration` (gitignored, mode 600).
Never publish that file. `TB_AUTH_TOKEN` is the new owner token; the old token is
not valid in Supabase. The owner can copy the new token from
`.local/access-token.txt` into the web login prompt; refresh the page afterwards
if signing in for the first time. This private file is not committed.

Reload/load the updated `extension/` directory in the browser extension manager
and replace its old saved token with the new one. A previously installed copy of
the extension still targets Cloudflare until updated.

## Local development

```sh
npm ci
npm test
python3 -m unittest discover -s tests -p 'test_*.py'
npm run dev
```

Open http://127.0.0.1:8080. Records are seeded once into `.local/database`.
The development server accepts only localhost requests and uses an HttpOnly
session cookie. Use this server, not the old `server.py` (which auto-publishes).
Semantic search needs the Supabase AI runtime; local preview returns a clear error.
Python pipelines read Supabase by default. Set `TB_API_URL` to target another API,
or `TB_OFFLINE_SNAPSHOT=1` explicitly for read-only offline analysis.

## Cutover checklist

1. For a new installation, create a Supabase project. The existing deployment
   above is already provisioned. Do not put credentials in git or chat.
2. Finish `node tools/backup-assets.mjs`. It checkpoints to
   `.local/asset-backup/records.json` and content-addressed JPEGs. Rerunning skips
   successful images. Unavailable images are reported, never deleted from the board.
3. Pause the old Cloudflare scraper and Mac publishers before the final snapshot.
   Refresh the JSON snapshot from the old API/repository and repeat the backup/import
   for any newly added records. Keep the old deployment for rollback until verification.
4. Authenticate the official Supabase CLI (`npx supabase login`), link the new project
   (`npx supabase link --project-ref PROJECT_REF`), then run `npx supabase db push`.
   Apply `supabase/migrations/202609230001_board.sql` exactly once. No Docker is needed
   for the remote migration. Direct public/anonymous table and RPC access is denied.
5. Set a NEW `TB_AUTH_TOKEN` and the existing `YOUTUBE_API_KEY` as Edge Function secrets.
   Store the token in a private env file (mode 600), not a command argument or source.
   Use `npx supabase secrets set --env-file .env.edge --project-ref PROJECT_REF`.
   The previously committed legacy board token must be retired at cutover.
6. Deploy: `npx supabase functions deploy board-api --project-ref PROJECT_REF --use-api`.
   `verify_jwt=false` is deliberate: public board reads work without an account;
   every write and private read requires the owner token. The service key stays in
   the Edge runtime, migration process and private local environment only.
7. Create `.env.migration` with SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
   TB_API_URL (the URL ending `/functions/v1/board-api`) and TB_AUTH_TOKEN.
   Run `node tools/migrate-supabase.mjs` to audit, then
   `node --env-file=.env.migration tools/migrate-supabase.mjs --apply`.
   The importer copies the original board/pending/inbox/rejected/discovery records,
   then uploads local image backups and recovered metadata. Conflicting IDs are
   ignored: rerunning cannot resurrect deleted/rejected items or undo later edits.
   See `.local/migration-report.json` for the verification result.
8. Run `node --env-file=.env.migration tools/drain-assets.mjs` for remaining jobs.
   Failed jobs back off and stop after 8 attempts; inspect `/api/maintenance/status`
   using X-Auth-Token. The database retains records for unavailable videos.
9. Reindex search with `TB_API_URL` and `TB_AUTH_TOKEN` exported, then
   `python3 build_embeddings.py`. A separate local manifest is used for Supabase.
   Existing 1024-dimension BGE-M3 vectors cannot be copied to native GTE-small's
   384-dimension index. Summaries and transcripts are reused. Live English
   queries returned relevant software-engineering results; the Spanish sample
   was less precise. GTE-small is primarily English, so prefer English queries
   until a multilingual provider is configured.
10. Add `tb_api_url` and `tb_auth_token` in Supabase Vault, then run
    `supabase/schedule.sql`. This archives images/metadata each minute and collects
    candidates every 6 hours. Inspect `cron.job_run_details` and pg_net responses.
    YouTube collection also requires YOUTUBE_API_KEY and sufficient API quota.
11. Set `apiBase` in `app-config.js` and the matching URL in `extension/config.js`.
    Test cloud CRUD, Saved, hide own, inbox, archived image URLs and Ideas. Update
    Mac jobs to export TB_API_URL. Publish the frontend and reload the extension.
    Rotate/remove the old Cloudflare token and disable its cron. Only remove its
    resources after all checks pass. Do not remove the original Git snapshot.

Supabase storage object bytes are not part of database backups. Keep the local
asset backup (or another independent copy) in addition to database backups.
Records and images use separate lifetimes: board deletion leaves image bytes in
Storage, and a deletion tombstone prevents scraper/tagger resurrection.

## Speed and inbox approvals (September 2026)

- Pages render immediately from the last board copy saved in the browser and
  refresh in the background; `/api/data` is one database query (`tb_list`) and is
  revalidated with an ETag. Cards are reused, so saving, sorting, filtering and
  refreshing never reload images. Grids load YouTube's full-resolution image
  first and fall back to the archived copy; full views prefer the archived image.
  New archive uploads are marked immutable for browser caching.
- Inbox: select the candidates you like; one button adds them to the board and
  discards every other candidate shown (only those loaded on the page).
- Inbox approvals go straight to the board (previously the
  default sent them to `pending`, waiting for the Mac tagger). Approved items go
  to the end of the board, so "Recent" shows them first. The inbox's "Waiting for
  tags" tab lists older approvals still in `pending` and can publish them.
- The Mac tagger (`auto_tag_tick.sh`) also tags untagged board items through
  `/api/tag-untagged`, which only writes when the item still has no tags.
  Its launchd job must export the NEW `TB_AUTH_TOKEN`; with the old Cloudflare
  token it cannot read `/api/pending` and silently does nothing.

Deploy order: `npx supabase db push` (migration `202609240002`), then
`npx supabase functions deploy board-api --project-ref PROJECT_REF --use-api`,
then publish the frontend (merge to `main`). The old function keeps working with
the new migration; the new frontend works with the old function except the
"Waiting for tags" publish button.

## Collector and tagging

`scrape_sources.json` has rotating niche and cross-topic search groups, rotating
seed channels and regions, and a per-channel cap. Query results are not limited to
seed channels. The database remembers seen IDs including rejected/deleted items.
Archiving detects exact duplicate image bytes and rejects duplicate inbox entries;
similar crops/edits are not a perceptual duplicate detector. Outlier score measures
video performance, not image quality.

The optional Jev adapter uses local Ollama vision to describe the image and OCR,
then asks Jev for structured tag confidence and visual-quality suggestions. It
never sends images directly to Jev and never auto-approves its output. Requires
an available TypeSafe API key and a running Ollama vision model:

```sh
python3 auto_tag.py --tagger jev --limit 10
python3 tools/review-inbox.py --limit 10
```

Set TYPESAFE_API_KEY, TB_API_URL and TB_AUTH_TOKEN privately first. The inbox can
sort by visual quality after review. Unscored items remain available. This adapter
is tested with synthetic responses; real accuracy, costs and calibration need a
small reviewed sample before expanding usage. A typed response does not guarantee
correct visual interpretation.

### Evaluating Jev before use (THE-61)

The request/response shapes were checked against the published docs (September
2026): `POST https://api.typesafe.ai/v1/systemone`, model `jev-latest`, Noul answers
in `answers.<tag>.noul`, Score criteria as an ordered array of 2–10 levels with
`score` and `confidence`. Jev is text-only, so image understanding stays in Ollama.
Before running `review-inbox.py`, evaluate a small sample. It is read-only:

```sh
python3 tools/jev-eval.py --limit 10                 # board: tags vs approved tags
python3 tools/jev-eval.py --source inbox --limit 10  # candidates: judge by eye
```

It writes `.local/jev-eval/<time>/report.html` and `report.json`: precision/recall
against approved visual tags (channel tags excluded), most frequent wrong/missed
tags, token use and estimated cost. With TB_AUTH_TOKEN the board sample is half
Saved: if Saved items do not score higher, the visual score is not reflecting our
taste and must not be used to rank the inbox. Outlier score is not an input.

## Multilingual search (THE-63)

Native `gte-small` is English-centred; Spanish queries against English summaries
and transcripts are imprecise. The API can instead use any OpenAI-compatible
embeddings endpoint that honours `dimensions: 384` (for example OpenAI
`text-embedding-3-small`), keeping the pgvector schema and every summary and
transcript. Each vector records its model; search, related results and the
discovery queue only use vectors from the active model, so a partial reindex never
mixes vector spaces. Without `EMBEDDING_*` secrets the API keeps using gte-small.
Summaries/transcripts are sent to that provider when indexing.

Compare before switching production (read-only baseline, then a local candidate):

```sh
node --env-file=.env.migration tools/search-eval.mjs      # current gte-small baseline
# Local candidate: separate PGlite database, production untouched
EMBEDDING_API_URL=https://api.openai.com/v1/embeddings EMBEDDING_API_KEY=… \
  EMBEDDING_MODEL=text-embedding-3-small TB_DEV_TOKEN=local-only npm run dev
TB_API_URL=http://127.0.0.1:8080 TB_AUTH_TOKEN=local-only python3 build_embeddings.py
TB_API_URL=http://127.0.0.1:8080 TB_AUTH_TOKEN=local-only node tools/search-eval.mjs
node tools/search-eval.mjs --compare .local/search-eval/A.json .local/search-eval/B.json
```

Put the key in a private env file rather than the shell history. Queries live in
`tools/search-eval-queries.json` (Spanish/English pairs); replace them with real
searches. `overlap@10` measures how many Spanish results match the English twin;
the comparison also prints titles for a human relevance check.

To switch production after a better result:
1. `npx supabase db push` (applies `202609240001_embedding_model.sql`; the current
   function keeps working with it). Deploy the function only after this.
2. Add `EMBEDDING_API_URL`, `EMBEDDING_API_KEY`, `EMBEDDING_MODEL` to `.env.edge`,
   `npx supabase secrets set --env-file .env.edge --project-ref PROJECT_REF`, then
   deploy `board-api`. `/api/health` reports `features.embeddingModel`.
3. Run `python3 build_embeddings.py` (a new manifest per model re-embeds everything
   from existing summaries/transcripts) and `python3 enrich_discovery.py`. Search
   returns only reindexed items until this finishes (minutes for ~2,200 items).
Rollback: remove the three secrets, redeploy and reindex with gte-small.

Sources: [Jev quick start](https://docs.typesafe.ai/introduction/quickstart),
[Supabase deployment](https://supabase.com/docs/guides/functions/deploy),
[Supabase Cron](https://supabase.com/docs/guides/cron),
[Storage](https://supabase.com/docs/guides/storage).

## Work tracking

[Linear project](https://linear.app/theseniordev-andrei/project/thumbnail-board-5fb5885a1a44)
tracks THE-54 through THE-62. Local implementation and tests are separate from the
cloud cutover; do not mark migration complete before the production checks above.
