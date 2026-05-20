# Migration to Cloudflare Workers

> **Status: COMPLETE.** This migration has already been done. The Worker is live at
> `https://thumbnail-board-api.andrei-nndd.workers.dev` and the board reads/writes
> through it. `server.py` is retired (kept on disk only as a backup reference).
>
> This file is kept as the historical playbook in case the Worker ever has to be
> redeployed from scratch (new Cloudflare account, lost secrets, etc.).

This guide walks you through replacing `server.py` with a Cloudflare Worker
so the board, tagger, and extension work without your Mac being on.

**Time required:** ~30 minutes
**Cost:** $0 (Cloudflare Workers free tier is 100k requests/day)
**You won't touch:** theseniordev.com DNS, your other domains

---

## What you'll set up

```
GitHub Pages (read-only)  ←  reads  data.json  ←  writes  Cloudflare Worker  ←  writes from anywhere
```

After migration:
- The public board lives at `andreinedelcu.github.io/thumbnail-board`
- All adds/edits/deletes go through the Worker
- You authenticate with a single secret token
- `server.py` and Eagle are no longer needed (you can keep them for local backup if you want)

---

## Step 1 — Sign up to Cloudflare

1. Go to https://dash.cloudflare.com/sign-up
2. Use your email; verify it.
3. You should land on a dashboard with "Workers & Pages" in the left sidebar.
   You don't need to add a website/domain.

## Step 2 — Create a GitHub Personal Access Token

The Worker needs permission to read/write `data.json` in your repo.

1. Go to https://github.com/settings/personal-access-tokens/new
2. Token name: `thumbnail-board-worker`
3. Expiration: **No expiration** (or 1 year)
4. Repository access: **Only select repositories** → choose `AndreiNedelcu/thumbnail-board`
5. Permissions → Repository permissions:
   - **Contents: Read and write**
   - **Metadata: Read-only** (auto-enabled)
6. Click **Generate token**
7. **Copy the token** (starts with `github_pat_...`). You'll paste it in Step 5.
   ⚠️ It's only shown once.

## Step 3 — Generate an auth token

This is the secret you (and the extension) use to talk to the Worker.

Open Terminal and run:
```bash
openssl rand -base64 32
```

Copy the output (long random string like `Rk1xQ9bP...`). Save it somewhere safe — you'll need it on every device that adds thumbnails (your laptop, phone, extension).

## Step 4 — Install Wrangler (Cloudflare's CLI)

```bash
# If you have npm/node:
npm install -g wrangler

# Or via Homebrew:
brew install cloudflare-wrangler2
```

Verify:
```bash
wrangler --version
```

## Step 5 — Configure and deploy

```bash
cd /Users/andrei/thumbnail-board/worker

# Log in to your Cloudflare account (opens a browser)
wrangler login

# Set the two secrets (you'll be prompted to paste them)
wrangler secret put GITHUB_TOKEN
#   → paste the github_pat_... from Step 2

wrangler secret put AUTH_TOKEN
#   → paste the openssl-generated token from Step 3

# Deploy
wrangler deploy
```

The output will print a URL like:
```
https://thumbnail-board-api.YOUR-USERNAME.workers.dev
```

**Copy that URL** — you'll paste it in Step 6.

## Step 6 — Wire the frontend to the Worker

Open these two files and replace the placeholder URL:

**`/Users/andrei/thumbnail-board/api-client.js`**:
```js
const WORKER_URL = 'https://thumbnail-board-api.andrei-nndd.workers.dev';
```
Change to your actual URL from Step 5 if redeploying.

**`/Users/andrei/thumbnail-board/extension/content.js`**:
```js
const WORKER_URL = 'https://thumbnail-board-api.andrei-nndd.workers.dev';
```
Same — change to your URL if redeploying.

Then commit & push:
```bash
cd /Users/andrei/thumbnail-board
git add api-client.js extension/content.js
git commit -m "config: point to deployed Worker URL"
git push
```

GitHub Pages picks up the change in ~30 seconds.

## Step 7 — Test it

### Public read
Visit `https://andreinedelcu.github.io/thumbnail-board` — the board should load all thumbnails.

### Write from the board
1. Open the board, click any thumbnail
2. Click "Edit tags" → tagger opens
3. The first time you try to save, a login overlay appears asking for the **AUTH_TOKEN** from Step 3 — paste it
4. Token is stored in localStorage; you'll never see the overlay again on this browser

### Write from the extension
1. Open `arc://extensions` (or `chrome://extensions`)
2. Reload the Thumbnail Board extension
3. Go to any YouTube video, click "Save to Board"
4. First save will prompt for the token; paste it
5. From now on saves work silently

## Step 8 — Retire `server.py`

Once you've confirmed everything works from the deployed URL:

- You no longer need to run `tagger.command` or `server.py`
- You no longer need Eagle (the data lives in `data.json` on GitHub)
- You can shut everything local down

If you want a backup workflow: keep `server.py` runnable. The board auto-detects
localhost and uses it when available, so you can still develop locally.

---

## Updating the Worker later

Any time you change `worker/index.js`:
```bash
cd worker
wrangler deploy
```
That's it. Takes ~5 seconds. No downtime.

## Rolling back

If something breaks:
```bash
wrangler deployments list
wrangler rollback <deployment-id>
```

## Cost monitoring

In the Cloudflare dashboard → Workers & Pages → your worker → Metrics.
Free tier: 100,000 requests/day. You'll never come close.

## Troubleshooting

**`Unauthorized` on every write** → AUTH_TOKEN doesn't match. Clear localStorage in DevTools (`localStorage.removeItem('tb-auth-token')`) and re-enter.

**`GitHub PUT failed: 401`** → GITHUB_TOKEN is invalid or expired. Generate a new one (Step 2), `wrangler secret put GITHUB_TOKEN` again.

**`GitHub PUT failed: 409`** → sha conflict. The Worker auto-retries 3 times. If it fails persistently, two devices are writing simultaneously — retry once.

**Extension still says "no video ID"** → reload extension at `arc://extensions` → 🔄, then Cmd+R the YouTube page.

**Site loads but writes fail with CORS errors** → make sure `wrangler deploy` succeeded and the URL in `api-client.js` matches exactly.
