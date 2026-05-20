/**
 * Thumbnail Board — Cloudflare Worker API
 *
 * Replaces server.py. Reads and writes data.json directly in the GitHub
 * repo via the Contents API. GitHub Pages auto-rebuilds on every push.
 *
 * Endpoints:
 *   GET  /api/data       — returns the full data.json (proxy, supports CORS)
 *   POST /api/add        — add a video { id, title, channel, views, tags }
 *   POST /api/delete     — delete a video { id }
 *   POST /api/update     — update tags { id (videoId) or vid, tags }
 *   POST /api/bulk-delete — delete many { ids: [...] } in one commit
 *
 * Secrets (set via `wrangler secret put NAME`):
 *   GITHUB_TOKEN  — PAT with Contents:write on the repo
 *   AUTH_TOKEN    — shared secret; clients send it in X-Auth-Token
 *
 * Variables (in wrangler.toml [vars]):
 *   GITHUB_REPO   — e.g. "AndreiNedelcu/thumbnail-board"
 *   DATA_PATH     — "data.json"
 *   BRANCH        — "main"
 */

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Auth-Token',
  'Access-Control-Max-Age': '86400',
};

function json(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS, ...extraHeaders },
  });
}

// ── GitHub Contents API helpers ─────────────────────────────────
async function ghGet(env) {
  const url = `https://api.github.com/repos/${env.GITHUB_REPO}/contents/${env.DATA_PATH}?ref=${env.BRANCH}`;
  const r = await fetch(url, {
    headers: {
      'Authorization': `Bearer ${env.GITHUB_TOKEN}`,
      'Accept': 'application/vnd.github+json',
      'User-Agent': 'thumbnail-board-worker',
    },
  });
  if (!r.ok) throw new Error(`GitHub GET failed: ${r.status} ${await r.text()}`);
  const data = await r.json();
  // content is base64
  const decoded = atob(data.content.replace(/\n/g, ''));
  const text = decodeURIComponent(escape(decoded)); // utf-8 safe
  return { text, sha: data.sha };
}

async function ghPut(env, newText, sha, message) {
  const url = `https://api.github.com/repos/${env.GITHUB_REPO}/contents/${env.DATA_PATH}`;
  const encoded = btoa(unescape(encodeURIComponent(newText)));
  const r = await fetch(url, {
    method: 'PUT',
    headers: {
      'Authorization': `Bearer ${env.GITHUB_TOKEN}`,
      'Accept': 'application/vnd.github+json',
      'User-Agent': 'thumbnail-board-worker',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ message, content: encoded, sha, branch: env.BRANCH }),
  });
  if (!r.ok) {
    const txt = await r.text();
    const err = new Error(`GitHub PUT failed: ${r.status} ${txt}`);
    err.status = r.status;
    throw err;
  }
  return r.json();
}

/** Read data.json, run `mutator(dataset)` (returns new dataset),
 *  write back. Retries on 409 sha conflicts. */
async function mutate(env, mutator, message) {
  const MAX_RETRIES = 3;
  let lastErr = null;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const { text, sha } = await ghGet(env);
      const dataset = JSON.parse(text);
      const newDataset = await mutator(dataset);
      if (newDataset == null) return { ok: true, msg: 'No change' };
      const newText = JSON.stringify(newDataset);
      await ghPut(env, newText, sha, message);
      return { ok: true, count: newDataset.length };
    } catch (e) {
      lastErr = e;
      if (e.status === 409) continue;        // sha conflict, retry
      throw e;
    }
  }
  throw lastErr || new Error('mutate: exhausted retries');
}

// ── Tag canonicalisation (mirrors server.py) ─────────────────────
const VALID_PREFIXES = new Set([
  'style','mood','text','element','camera','subject',
  'formation','topic','callout','backdrop','channel',
]);
function canonicaliseTags(raw) {
  const out = [];
  for (const t of (raw || [])) {
    const v = String(t).trim().toLowerCase();
    if (!v) continue;
    const prefix = v.split('-')[0];
    if (!VALID_PREFIXES.has(prefix)) continue;
    if (!out.includes(v)) out.push(v);
  }
  return out;
}

// ── Auth ─────────────────────────────────────────────────────────
function authed(req, env) {
  const token = req.headers.get('X-Auth-Token');
  return token && token === env.AUTH_TOKEN;
}

// ── Route handlers ───────────────────────────────────────────────
async function handleData(env) {
  const { text } = await ghGet(env);
  return new Response(text, {
    status: 200,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}

async function handleAdd(body, env) {
  const vid = body.id || body.videoId || '';
  if (!vid) return json({ ok: false, msg: 'No video id' }, 400);
  const entry = {
    id: vid,
    title: body.title || '',
    channel: body.channel || '',
    views: body.views || '',
    tags: canonicaliseTags(body.tags),
    eid: body.eid || '',
  };
  const result = await mutate(env, (dataset) => {
    if (dataset.some(v => v.id === vid)) {
      return null; // already exists, no change
    }
    return [...dataset, entry];
  }, `data: add ${vid} (${(body.title || '').slice(0, 50)})`);
  if (result.msg === 'No change') return json({ ok: false, msg: 'Already in board' });
  return json({ ok: true, entry });
}

async function handleDelete(body, env) {
  const vid = body.id || '';
  if (!vid) return json({ ok: false, msg: 'No id' }, 400);
  const result = await mutate(env, (dataset) => {
    const filtered = dataset.filter(v => v.id !== vid);
    if (filtered.length === dataset.length) return null;
    return filtered;
  }, `data: delete ${vid}`);
  if (result.msg === 'No change') return json({ ok: false, msg: 'Not found' });
  return json({ ok: true, msg: `Deleted ${vid}` });
}

async function handleAddBatch(body, env) {
  const items = Array.isArray(body.items) ? body.items : [];
  if (!items.length) return json({ ok: false, msg: 'No items' }, 400);
  const entries = items.map(it => ({
    id: it.id || it.videoId || '',
    title: it.title || '',
    channel: it.channel || '',
    views: it.views || '',
    tags: canonicaliseTags(it.tags),
    eid: it.eid || '',
  })).filter(e => e.id);
  if (!entries.length) return json({ ok: false, msg: 'No valid items' }, 400);

  let addedCount = 0;
  let skippedCount = 0;
  const result = await mutate(env, (dataset) => {
    const existing = new Set(dataset.map(v => v.id));
    const additions = entries.filter(e => {
      if (existing.has(e.id)) { skippedCount++; return false; }
      existing.add(e.id);
      return true;
    });
    addedCount = additions.length;
    if (!additions.length) return null;
    return [...dataset, ...additions];
  }, `data: batch add ${entries.length} thumbnails (+${entries.length - skippedCount} new)`);

  return json({ ok: true, added: addedCount, skipped: skippedCount, total: result.count || null });
}

async function handleBulkDelete(body, env) {
  const ids = Array.isArray(body.ids) ? body.ids : [];
  if (!ids.length) return json({ ok: false, msg: 'No ids' }, 400);
  const idSet = new Set(ids);
  const result = await mutate(env, (dataset) => {
    const filtered = dataset.filter(v => !idSet.has(v.id));
    if (filtered.length === dataset.length) return null;
    return filtered;
  }, `data: bulk-delete ${ids.length} items`);
  return json({ ok: true, deleted: ids.length, total: result.count });
}

async function handleUpdate(body, env) {
  const vid = body.vid || body.id || '';
  if (!vid) return json({ ok: false, msg: 'No id' }, 400);
  const hasTags    = Array.isArray(body.tags);
  const hasViews   = typeof body.views === 'string';
  const hasTitle   = typeof body.title === 'string' || typeof body.name === 'string';
  const hasChannel = typeof body.channel === 'string';
  const tags = hasTags ? canonicaliseTags(body.tags) : null;
  const titleVal = body.title ?? body.name ?? '';

  const result = await mutate(env, (dataset) => {
    const idx = dataset.findIndex(v => v.id === vid || v.eid === vid);
    if (idx === -1) {
      const entry = {
        id: body.vid || vid, title: titleVal, channel: body.channel || '',
        views: body.views || '', tags: tags || [],
        eid: body.eid || (body.id !== body.vid ? body.id : ''),
      };
      return [...dataset, entry];
    }
    const copy = [...dataset];
    const updated = { ...copy[idx] };
    if (hasTags)    updated.tags    = tags;
    if (hasViews)   updated.views   = body.views;
    if (hasTitle)   updated.title   = titleVal;
    if (hasChannel) updated.channel = body.channel;
    if (body.eid && !updated.eid) updated.eid = body.eid;
    copy[idx] = updated;
    return copy;
  }, `data: update ${vid}`);
  return json({ ok: true, count: result.count });
}

async function handleUpdateBatch(body, env) {
  const items = Array.isArray(body.items) ? body.items : [];
  if (!items.length) return json({ ok: false, msg: 'No items' }, 400);
  let updated = 0;
  let added = 0;
  const result = await mutate(env, (dataset) => {
    const copy = [...dataset];
    for (const it of items) {
      const vid = it.vid || it.id;
      if (!vid) continue;
      const idx = copy.findIndex(v => v.id === vid || v.eid === vid);
      if (idx === -1) continue;            // batch is for backfill, not insert
      const cur = { ...copy[idx] };
      if (typeof it.views   === 'string') cur.views   = it.views;
      if (typeof it.title   === 'string') cur.title   = it.title;
      if (typeof it.channel === 'string') cur.channel = it.channel;
      if (Array.isArray(it.tags))         cur.tags    = canonicaliseTags(it.tags);
      copy[idx] = cur;
      updated++;
    }
    if (!updated) return null;
    return copy;
  }, `data: batch update ${items.length} items`);
  return json({ ok: true, updated, added });
}

// ── Main fetch handler ───────────────────────────────────────────
export default {
  async fetch(req, env) {
    if (req.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }
    const url = new URL(req.url);
    const path = url.pathname;

    // Public read endpoint (no auth)
    if (path === '/api/data' && req.method === 'GET') {
      try { return await handleData(env); }
      catch (e) { return json({ ok: false, msg: e.message }, 500); }
    }

    // Health check
    if (path === '/api/health') return json({ ok: true });

    // All write endpoints require auth
    if (path.startsWith('/api/') && req.method === 'POST') {
      if (!authed(req, env)) return json({ ok: false, msg: 'Unauthorized' }, 401);
      let body;
      try { body = await req.json(); }
      catch { return json({ ok: false, msg: 'Bad JSON' }, 400); }
      try {
        if (path === '/api/add')          return await handleAdd(body, env);
        if (path === '/api/add-batch')    return await handleAddBatch(body, env);
        if (path === '/api/delete')       return await handleDelete(body, env);
        if (path === '/api/bulk-delete')  return await handleBulkDelete(body, env);
        if (path === '/api/update-batch') return await handleUpdateBatch(body, env);
        if (path === '/api/update' || path === '/api/eagle/update')
                                          return await handleUpdate(body, env);
      } catch (e) {
        return json({ ok: false, msg: e.message }, 500);
      }
    }

    return json({ ok: false, msg: 'Not found' }, 404);
  },
};
