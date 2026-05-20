/**
 * Thumbnail Board — Cloudflare Worker API
 *
 * Replaces server.py. Reads and writes data.json directly in the GitHub
 * repo via the Contents API. GitHub Pages auto-rebuilds on every push.
 *
 * Endpoints:
 *   GET  /api/data            — proxies data.json (CORS, no auth)
 *   GET  /api/health          — health check
 *   GET  /api/inbox           — proxies scrape_inbox.json (CORS, no auth)
 *
 *   POST /api/add             — add one video
 *   POST /api/add-batch       — add many in one commit
 *   POST /api/delete          — delete one
 *   POST /api/bulk-delete     — delete many in one commit
 *   POST /api/update          — update fields on a video (or create if missing)
 *   POST /api/update-batch    — update many in one commit
 *
 *   POST /api/inbox/approve   — { ids, destination: "pending"|"board" }
 *   POST /api/inbox/reject    — { ids }
 *   POST /api/scrape/run      — manual trigger of the scrape bot
 *
 * Scheduled handler (cron in wrangler.toml) runs the scrape bot every 6h.
 *
 * Secrets (set via `wrangler secret put NAME`):
 *   GITHUB_TOKEN     — PAT with Contents:write on the repo
 *   AUTH_TOKEN       — shared secret; clients send it in X-Auth-Token
 *   YOUTUBE_API_KEY  — YouTube Data API v3 key (Google Cloud)
 *
 * Variables (in wrangler.toml [vars]):
 *   GITHUB_REPO   — e.g. "AndreiNedelcu/thumbnail-board"
 *   DATA_PATH     — "data.json"
 *   BRANCH        — "main"
 */

import { runScrape } from './scrape.js';

const INBOX_PATH    = 'scrape_inbox.json';
const REJECTED_PATH = 'scrape_rejected.json';
const SOURCES_PATH  = 'scrape_sources.json';
const BLOCKLIST_PATH = 'scrape_channel_blocklist.json';
const PENDING_PATH  = 'eagle-pending.json';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Auth-Token',
  'Access-Control-Max-Age':       '86400',
};

function json(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS, ...extraHeaders },
  });
}

// ── GitHub Contents API helpers ─────────────────────────────────────
async function ghGet(env, path = env.DATA_PATH) {
  const url = `https://api.github.com/repos/${env.GITHUB_REPO}/contents/${path}?ref=${env.BRANCH}`;
  const r = await fetch(url, {
    headers: {
      'Authorization': `Bearer ${env.GITHUB_TOKEN}`,
      'Accept':        'application/vnd.github+json',
      'User-Agent':    'thumbnail-board-worker',
    },
  });
  if (r.status === 404) return { text: null, sha: null, missing: true };
  if (!r.ok) throw new Error(`GitHub GET ${path} failed: ${r.status} ${await r.text()}`);
  const data = await r.json();
  const decoded = atob(data.content.replace(/\n/g, ''));
  const text = decodeURIComponent(escape(decoded)); // utf-8 safe
  return { text, sha: data.sha };
}

async function ghPut(env, newText, sha, message, path = env.DATA_PATH) {
  const url = `https://api.github.com/repos/${env.GITHUB_REPO}/contents/${path}`;
  const encoded = btoa(unescape(encodeURIComponent(newText)));
  const body = { message, content: encoded, branch: env.BRANCH };
  if (sha) body.sha = sha;
  const r = await fetch(url, {
    method: 'PUT',
    headers: {
      'Authorization': `Bearer ${env.GITHUB_TOKEN}`,
      'Accept':        'application/vnd.github+json',
      'User-Agent':    'thumbnail-board-worker',
      'Content-Type':  'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const txt = await r.text();
    const err = new Error(`GitHub PUT ${path} failed: ${r.status} ${txt}`);
    err.status = r.status;
    throw err;
  }
  return r.json();
}

/** Read file, run `mutator(parsed)` (returns new parsed value or null to skip),
 *  write back. Retries on 409 sha conflicts. */
async function mutate(env, mutator, message, path = env.DATA_PATH) {
  const MAX_RETRIES = 3;
  let lastErr = null;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const { text, sha, missing } = await ghGet(env, path);
      const dataset = missing ? [] : JSON.parse(text);
      const newDataset = await mutator(dataset);
      if (newDataset == null) return { ok: true, msg: 'No change' };
      const newText = JSON.stringify(newDataset);
      await ghPut(env, newText, sha, message, path);
      return { ok: true, count: Array.isArray(newDataset) ? newDataset.length : null };
    } catch (e) {
      lastErr = e;
      if (e.status === 409) continue;
      throw e;
    }
  }
  throw lastErr || new Error('mutate: exhausted retries');
}

// ── Tag canonicalisation (mirrors server.py) ────────────────────────
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

// ── Auth ────────────────────────────────────────────────────────────
function authed(req, env) {
  const token = req.headers.get('X-Auth-Token');
  return token && token === env.AUTH_TOKEN;
}

// ── Existing data.json handlers (unchanged behavior) ────────────────
async function handleData(env) {
  const { text } = await ghGet(env);
  return new Response(text, {
    status: 200,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}

/**
 * Format a raw view count to the "1.2M / 847K / 1234" string used in data.json.
 */
function formatViewCount(n) {
  if (!Number.isFinite(n) || n <= 0) return '';
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M';
  if (n >= 1_000)     return (n / 1_000).toFixed(1).replace(/\.0$/, '') + 'K';
  return String(n);
}

/**
 * Last-resort metadata fetch via YouTube Data API v3 — used when the
 * extension couldn't scrape the watch-page DOM and sent the Worker a
 * blank title/channel/views. Costs 1 quota unit per call.
 */
async function fillMissingMetadata(entry, env) {
  if (entry.title && entry.channel && entry.views) return entry;
  if (!env.YOUTUBE_API_KEY) return entry;
  try {
    const url = `https://www.googleapis.com/youtube/v3/videos?part=snippet,statistics&id=${encodeURIComponent(entry.id)}&key=${env.YOUTUBE_API_KEY}`;
    const r = await fetch(url);
    if (!r.ok) return entry;
    const data = await r.json();
    const item = data.items?.[0];
    if (!item) return entry;
    if (!entry.title)   entry.title   = item.snippet?.title || '';
    if (!entry.channel) entry.channel = item.snippet?.channelTitle || '';
    if (!entry.views)   entry.views   = formatViewCount(parseInt(item.statistics?.viewCount || '0', 10));
  } catch {}
  return entry;
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

  // Server-side fallback for the chrome extension when it fails to scrape
  // YouTube's DOM (selectors change every couple of months). Silent if the
  // YouTube Data API is over quota — extension falls through with whatever
  // metadata it managed to grab.
  await fillMissingMetadata(entry, env);

  const result = await mutate(env, (dataset) => {
    if (dataset.some(v => v.id === vid)) return null;
    return [...dataset, entry];
  }, `data: add ${vid} (${(entry.title || '').slice(0, 50)})`);
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
      if (idx === -1) continue;
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

// ── Inbox handlers ──────────────────────────────────────────────────
async function handleGetInbox(env) {
  const { text, missing } = await ghGet(env, INBOX_PATH);
  return new Response(missing ? '[]' : text, {
    status: 200,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}

async function handleInboxApprove(body, env) {
  const ids = Array.isArray(body.ids) ? body.ids : [];
  if (!ids.length) return json({ ok: false, msg: 'No ids' }, 400);
  const destination = body.destination === 'board' ? 'board' : 'pending';
  const idSet = new Set(ids);

  // 1) Read the inbox to get the full entries we're approving
  const { text: inboxText, missing: inboxMissing } = await ghGet(env, INBOX_PATH);
  const inbox = inboxMissing ? [] : JSON.parse(inboxText);
  const approving = inbox.filter(it => idSet.has(it.id));
  if (!approving.length) return json({ ok: false, msg: 'None of the ids are in the inbox' }, 404);

  // 2) Convert to destination-shape entries
  const entries = approving.map(it => ({
    id:      it.id,
    eid:     '',
    title:   it.title || '',
    channel: it.channel || '',
    views:   it.views || '',
    tags:    destination === 'pending' ? ['thumbnail', 'youtube'] : [],
  }));

  let movedToDest = 0;
  let movedToDestSkipped = 0;

  if (destination === 'board') {
    // Append to data.json, dedup against existing
    await mutate(env, (dataset) => {
      const existing = new Set(dataset.map(v => v.id));
      const additions = entries.filter(e => {
        if (existing.has(e.id)) { movedToDestSkipped++; return false; }
        existing.add(e.id);
        return true;
      });
      movedToDest = additions.length;
      if (!additions.length) return null;
      return [...dataset, ...additions];
    }, `data: approve ${entries.length} from inbox → board`);
  } else {
    // Append to eagle-pending.json
    await mutate(env, (dataset) => {
      const existing = new Set(dataset.map(v => v.id));
      const additions = entries.filter(e => {
        if (existing.has(e.id)) { movedToDestSkipped++; return false; }
        existing.add(e.id);
        return true;
      });
      movedToDest = additions.length;
      if (!additions.length) return null;
      return [...dataset, ...additions];
    }, `pending: approve ${entries.length} from inbox`, PENDING_PATH);
  }

  // 3) Remove approved ids from the inbox
  await mutate(env, (current) => {
    const remaining = current.filter(it => !idSet.has(it.id));
    if (remaining.length === current.length) return null;
    return remaining;
  }, `inbox: remove ${ids.length} approved`, INBOX_PATH);

  return json({
    ok: true,
    destination,
    moved: movedToDest,
    skipped: movedToDestSkipped,
  });
}

async function handleBlockChannel(body, env) {
  const channelId   = String(body.channelId   || '').trim();
  const channelName = String(body.channelName || '').trim();
  if (!channelId) return json({ ok: false, msg: 'No channelId' }, 400);

  // 1) Append to channel blocklist (idempotent)
  let added = false;
  await mutate(env, (current) => {
    const blocked = Array.isArray(current) ? current : [];
    if (blocked.some(b => b?.channelId === channelId)) return null;
    added = true;
    return [...blocked, {
      channelId,
      channelName: channelName || '(unknown)',
      blockedAt:   new Date().toISOString(),
    }];
  }, `blocklist: +${channelName || channelId}`, BLOCKLIST_PATH);

  // 2) Drop any items currently in the inbox from that channel.
  //    Their video IDs go to scrape_rejected.json so they don't sneak
  //    back via search/trending discovery.
  const { text: inboxText, missing } = await ghGet(env, INBOX_PATH);
  const inbox = missing ? [] : JSON.parse(inboxText);
  const removedIds = inbox.filter(it => it.channelId === channelId).map(it => it.id);

  if (removedIds.length) {
    await mutate(env, (rejected) => {
      const existing = new Set(rejected);
      const newOnes = removedIds.filter(id => !existing.has(id));
      if (!newOnes.length) return null;
      return [...rejected, ...newOnes];
    }, `rejected: +${removedIds.length} from blocked channel`, REJECTED_PATH);

    await mutate(env, (current) => {
      const remaining = current.filter(it => it.channelId !== channelId);
      if (remaining.length === current.length) return null;
      return remaining;
    }, `inbox: drop ${removedIds.length} from blocked ${channelName || channelId}`, INBOX_PATH);
  }

  return json({ ok: true, channelId, channelName, added, removed: removedIds.length });
}

async function handleInboxReject(body, env) {
  const ids = Array.isArray(body.ids) ? body.ids : [];
  if (!ids.length) return json({ ok: false, msg: 'No ids' }, 400);
  const idSet = new Set(ids);

  // 1) Append to scrape_rejected.json (as bare id strings — light)
  let addedRejected = 0;
  await mutate(env, (rejected) => {
    const existing = new Set(rejected);
    const additions = ids.filter(id => !existing.has(id));
    addedRejected = additions.length;
    if (!additions.length) return null;
    return [...rejected, ...additions];
  }, `rejected: +${ids.length} from inbox`, REJECTED_PATH);

  // 2) Remove from inbox
  let removedFromInbox = 0;
  await mutate(env, (inbox) => {
    const remaining = inbox.filter(it => !idSet.has(it.id));
    removedFromInbox = inbox.length - remaining.length;
    if (!removedFromInbox) return null;
    return remaining;
  }, `inbox: reject ${ids.length}`, INBOX_PATH);

  return json({ ok: true, rejected: addedRejected, removedFromInbox });
}

// ── Ideas page: semantic search across the board ────────────────────
// Uses CF Workers AI (bge-m3 multilingual, 1024-dim embeddings) +
// CF Vectorize (binding VECTORIZE) for kNN search.
const EMBED_MODEL = '@cf/baai/bge-m3';

async function embedText(env, text) {
  const trimmed = (text || '').slice(0, 30000);  // bge-m3 max ~8192 tokens; chars cap as safety
  const resp = await env.AI.run(EMBED_MODEL, { text: [trimmed] });
  const v = resp?.data?.[0];
  if (!Array.isArray(v) || v.length !== 1024) {
    throw new Error(`Bad embedding (got length ${v?.length})`);
  }
  return v;
}

async function handleIdeasEmbed(body, env) {
  const id   = String(body.id || '').trim();
  const text = String(body.text || '').trim();
  if (!id || !text) return json({ ok: false, msg: 'Need id and text' }, 400);

  const meta = {
    title:   String(body.title   || '').slice(0, 240),
    channel: String(body.channel || '').slice(0, 120),
    is_own:  !!body.is_own,
  };

  try {
    const vec = await embedText(env, text);
    await env.VECTORIZE.upsert([{ id, values: vec, metadata: meta }]);
    return json({ ok: true, id, dim: vec.length });
  } catch (e) {
    return json({ ok: false, msg: e.message }, 500);
  }
}

async function handleIdeasRelated(body, env) {
  const id = String(body.id || '').trim();
  if (!id) return json({ ok: false, msg: 'Need id' }, 400);
  const topK = Math.max(1, Math.min(24, body.topK || 8));

  try {
    const fetched = await env.VECTORIZE.getByIds([id]);
    if (!fetched || !fetched.length) {
      return json({ ok: false, msg: `id ${id} not found in index` }, 404);
    }
    const vec = fetched[0].values;
    // Over-fetch by 1 so we can drop self from results
    const res = await env.VECTORIZE.query(vec, { topK: topK + 1, returnMetadata: true });
    const matches = (res.matches || []).filter(m => m.id !== id).slice(0, topK);
    return json({
      ok: true,
      seed: { id, title: fetched[0].metadata?.title || '' },
      results: matches.map(m => ({
        id:      m.id,
        score:   +(m.score || 0).toFixed(3),
        title:   m.metadata?.title   || '',
        channel: m.metadata?.channel || '',
        is_own:  !!m.metadata?.is_own,
      })),
    });
  } catch (e) {
    return json({ ok: false, msg: e.message }, 500);
  }
}

async function handleIdeasSearch(body, env) {
  const title  = String(body.title  || '').trim();
  const script = String(body.script || '').trim();
  if (!title && !script) return json({ ok: false, msg: 'Need title or script' }, 400);

  const includeOwn = body.includeOwnChannels !== false; // default true
  const topK       = Math.max(1, Math.min(50, body.topK || 12));
  const text       = [title, script].filter(Boolean).join('\n\n');

  try {
    const vec = await embedText(env, text);
    // Over-fetch when excluding own channels so we have room after filter
    const fetchK = includeOwn ? topK : Math.min(topK * 2, 50);
    const res = await env.VECTORIZE.query(vec, { topK: fetchK, returnMetadata: true });
    let matches = res.matches || [];
    if (!includeOwn) {
      matches = matches.filter(m => !m.metadata?.is_own).slice(0, topK);
    } else {
      matches = matches.slice(0, topK);
    }
    return json({
      ok: true,
      query: { title_chars: title.length, script_chars: script.length },
      results: matches.map(m => ({
        id:      m.id,
        score:   +(m.score || 0).toFixed(3),
        title:   m.metadata?.title   || '',
        channel: m.metadata?.channel || '',
        is_own:  !!m.metadata?.is_own,
      })),
    });
  } catch (e) {
    return json({ ok: false, msg: e.message }, 500);
  }
}

// ── Scrape (manual + scheduled) ─────────────────────────────────────
async function runScrapeAndPersist(env) {
  // 1) Load sources
  const { text: sourcesText, missing: sourcesMissing } = await ghGet(env, SOURCES_PATH);
  if (sourcesMissing) {
    return { ok: false, msg: `${SOURCES_PATH} not found in repo`, stats: null };
  }
  let sources;
  try { sources = JSON.parse(sourcesText); }
  catch (e) { return { ok: false, msg: `Bad ${SOURCES_PATH}: ${e.message}`, stats: null }; }

  // 2) Build excludeIds from data.json + eagle-pending.json + inbox + rejected
  //    and blockedChannelIds from the channel blocklist
  const [dataR, pendingR, inboxR, rejectedR, blocklistR] = await Promise.all([
    ghGet(env, env.DATA_PATH),
    ghGet(env, PENDING_PATH),
    ghGet(env, INBOX_PATH),
    ghGet(env, REJECTED_PATH),
    ghGet(env, BLOCKLIST_PATH),
  ]);
  const excludeIds = new Set();
  if (dataR.text)     for (const v of JSON.parse(dataR.text))     excludeIds.add(v.id);
  if (pendingR.text)  for (const v of JSON.parse(pendingR.text))  excludeIds.add(v.id);
  if (inboxR.text)    for (const v of JSON.parse(inboxR.text))    excludeIds.add(v.id);
  if (rejectedR.text) for (const id of JSON.parse(rejectedR.text)) excludeIds.add(id);

  const blockedChannelIds = new Set();
  if (blocklistR.text) {
    for (const entry of JSON.parse(blocklistR.text)) {
      if (entry?.channelId) blockedChannelIds.add(entry.channelId);
    }
  }

  // 3) Run the scrape
  const { candidates, stats } = await runScrape(env, sources, excludeIds, blockedChannelIds);

  // 4) Append new candidates to the inbox, honouring max_inbox_size.
  //    The cap stops the cron from drowning the user — when the inbox
  //    reaches the limit, new scrapes silently keep nothing until the
  //    user curates some out. Already-discovered IDs that get dropped
  //    here will simply reappear in a future scrape (they aren't yet
  //    in scrape_rejected.json).
  const maxInboxSize = Number.isFinite(sources?.thresholds?.max_inbox_size)
    ? sources.thresholds.max_inbox_size
    : Infinity;

  const currentInbox = inboxR.text ? JSON.parse(inboxR.text) : [];
  const existingInboxIds = new Set(currentInbox.map(it => it.id));
  const newOnes = candidates.filter(c => !existingInboxIds.has(c.id));
  const slotsLeft = Math.max(0, maxInboxSize - currentInbox.length);
  const willAdd = newOnes.slice(0, slotsLeft);   // candidates are already sorted by score desc
  const cappedOut = newOnes.length - willAdd.length;

  if (willAdd.length) {
    await mutate(env, (current) => {
      // Re-check inside the transaction in case the inbox changed
      // between our read above and this mutate.
      const existing = new Set(current.map(it => it.id));
      const additions = willAdd.filter(c => !existing.has(c.id));
      const finalSlots = Math.max(0, maxInboxSize - current.length);
      const finalAdditions = additions.slice(0, finalSlots);
      if (!finalAdditions.length) return null;
      return [...current, ...finalAdditions];
    }, `inbox: +${willAdd.length} from scrape (top x${willAdd[0].outlierScore})`, INBOX_PATH);
  }

  stats.inbox_size_before = currentInbox.length;
  stats.inbox_capped_out  = cappedOut;
  stats.max_inbox_size    = maxInboxSize;
  return { ok: true, added: willAdd.length, capped: cappedOut, stats };
}

async function handleScrapeRun(env) {
  try {
    const result = await runScrapeAndPersist(env);
    return json(result, result.ok ? 200 : 500);
  } catch (e) {
    return json({ ok: false, msg: e.message }, 500);
  }
}

// ── Main fetch handler ──────────────────────────────────────────────
export default {
  async fetch(req, env) {
    if (req.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }
    const url = new URL(req.url);
    const path = url.pathname;

    // Public reads
    if (path === '/api/data'   && req.method === 'GET') {
      try { return await handleData(env); }
      catch (e) { return json({ ok: false, msg: e.message }, 500); }
    }
    if (path === '/api/inbox'  && req.method === 'GET') {
      try { return await handleGetInbox(env); }
      catch (e) { return json({ ok: false, msg: e.message }, 500); }
    }
    if (path === '/api/health') return json({ ok: true });

    // All write endpoints require auth
    if (path.startsWith('/api/') && req.method === 'POST') {
      if (!authed(req, env)) return json({ ok: false, msg: 'Unauthorized' }, 401);
      let body;
      try { body = await req.json(); }
      catch { body = {}; }
      try {
        if (path === '/api/add')             return await handleAdd(body, env);
        if (path === '/api/add-batch')       return await handleAddBatch(body, env);
        if (path === '/api/delete')          return await handleDelete(body, env);
        if (path === '/api/bulk-delete')     return await handleBulkDelete(body, env);
        if (path === '/api/update-batch')    return await handleUpdateBatch(body, env);
        if (path === '/api/update' || path === '/api/eagle/update')
                                             return await handleUpdate(body, env);
        if (path === '/api/inbox/approve')        return await handleInboxApprove(body, env);
        if (path === '/api/inbox/reject')         return await handleInboxReject(body, env);
        if (path === '/api/inbox/block-channel')  return await handleBlockChannel(body, env);
        if (path === '/api/scrape/run')           return await handleScrapeRun(env);
        if (path === '/api/ideas/embed')          return await handleIdeasEmbed(body, env);
        if (path === '/api/ideas/search')         return await handleIdeasSearch(body, env);
        if (path === '/api/ideas/related')        return await handleIdeasRelated(body, env);
      } catch (e) {
        return json({ ok: false, msg: e.message }, 500);
      }
    }

    return json({ ok: false, msg: 'Not found' }, 404);
  },

  // Cron trigger — see [triggers].crons in wrangler.toml
  async scheduled(_event, env, ctx) {
    ctx.waitUntil((async () => {
      try {
        const result = await runScrapeAndPersist(env);
        console.log('scheduled scrape:', JSON.stringify(result));
      } catch (e) {
        console.error('scheduled scrape failed:', e.message);
      }
    })());
  },
};
