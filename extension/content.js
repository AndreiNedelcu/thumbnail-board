// ── Thumbnail Board Extension · AI auto-tag ────────────────────────
// One-click save from anywhere on YouTube: watch pages, home, search,
// feed. Auto-tags with local Ollama and publishes to the board.
// Marks already-saved videos so you don't re-process.

const WORKER_URL = 'https://thumbnail-board-api.andrei-nndd.workers.dev';
const LOCAL_URL  = 'http://localhost:3000';
const OLLAMA_URL = 'http://localhost:11434';
const MODEL      = 'qwen2.5vl:7b';

let SERVER = WORKER_URL;
let AUTH_TOKEN = '';
let currentVideoId = null;
let saving = new Set();              // video IDs currently being saved
const savedVideoIds = new Set();     // cache of what's in the board

// ── Taxonomy (must match Worker canonicaliseTags + auto_tag.py) ───
const CATS = {
  STYLE:     ['colorful','high-contrast','minimal','split-screen','illustration','handdrawn','3d','photoshopped','collage','anatomy','busy','match-split','monochrome','pattern','dissolving','photo-composite'],
  MOOD:      ['dramatic','happy','serious','entertaining','confused','exhausted','frustrated','sad','surprised','skeptical'],
  TEXT:      ['identity','callout','question','normative-claim','number','quote','forward-referencing','cta','in-center','in-background','direct-address','chat','answer'],
  ELEMENT:   ['celebrity','graphic','chart','unusual','glow','logo','screen','money','in-background','fire','hand','in-foreground','in-motion','obfuscation','eye','map','vehicle','pile','damage','animal','food','book','brain','crowd','emoji','notification','checkbox','review','building'],
  CAMERA:    ['medium-shot','close-up','overhead-shot','full-shot','aerial-shot','back-shot','unusual'],
  SUBJECT:   ['in-motion','holding-object','count-two','count-many','in-background','unusual-pose','talking','laying','sitting','clone'],
  FORMATION: ['flat-lay','line','grid','v'],
  TOPIC:     ['comparison','product-showcase','space','secret','social-media','size'],
  CALLOUT:   ['magnifier'],
  BACKDROP:  ['dark','light','blurry'],
};
const ALL_VALID = new Set(
  Object.entries(CATS).flatMap(([cat, subs]) => subs.map(s => `${cat.toLowerCase()}-${s}`))
);
const TAXONOMY_STR = Object.entries(CATS)
  .map(([cat, subs]) => `  ${cat.toLowerCase()}: ${subs.map(s => `${cat.toLowerCase()}-${s}`).join(', ')}`)
  .join('\n');

// ── Video metadata scraping ───────────────────────────────────────
function getVideoIdFromWatchPage() {
  const RE = /[?&]v=([A-Za-z0-9_-]{11})|\/shorts\/([A-Za-z0-9_-]{11})/;
  const watchEl = document.querySelector('ytd-watch-flexy, ytd-watch-two');
  if (watchEl) { const v = watchEl.getAttribute('video-id'); if (v) return v; }
  let m = location.href.match(RE);             if (m) return m[1] || m[2];
  m = document.URL.match(RE);                  if (m) return m[1] || m[2];
  const canon = document.querySelector('link[rel="canonical"]');
  if (canon?.href) { m = canon.href.match(RE); if (m) return m[1] || m[2]; }
  const og = document.querySelector('meta[property="og:url"]');
  if (og?.content) { m = og.content.match(RE); if (m) return m[1] || m[2]; }
  if (currentVideoId) return currentVideoId;
  return null;
}

function getWatchPageInfo() {
  const id = getVideoIdFromWatchPage();
  if (!id) return null;
  const title = document.querySelector('h1.ytd-video-primary-info-renderer yt-formatted-string, h1 yt-formatted-string.ytd-watch-metadata')?.textContent?.trim()
    || document.title.replace(' - YouTube','').trim();
  const channel = document.querySelector('ytd-channel-name yt-formatted-string a, #channel-name a')?.textContent?.trim() || '';
  let views = '';
  try {
    for (const script of document.querySelectorAll('script:not([src])')) {
      const t = script.textContent;
      if (!t.includes('viewCount')) continue;
      const m = t.match(/"viewCount"\s*:\s*"(\d+)"/);
      if (m) {
        const n = parseInt(m[1], 10);
        if (n >= 1_000_000) views = (n/1_000_000).toFixed(1).replace(/\.0$/, '') + 'M';
        else if (n >= 1_000) views = (n/1_000).toFixed(1).replace(/\.0$/, '') + 'K';
        else views = n.toString();
        break;
      }
    }
  } catch {}
  if (!views) {
    const el = document.querySelector('ytd-video-view-count-renderer span');
    if (el) views = el.textContent.trim().replace(/\s*views?/i,'').trim();
  }
  return { id, title, channel, views };
}

/** Extract video info from a card element on home / search / feed. */
function getCardInfo(card) {
  // Find the watch link inside the card
  const link = card.querySelector('a[href*="/watch?v="]');
  if (!link) return null;
  const m = link.href.match(/[?&]v=([A-Za-z0-9_-]{11})/);
  if (!m) return null;
  const id = m[1];

  const title = card.querySelector('#video-title, yt-formatted-string.ytd-rich-grid-media, a#video-title-link')?.textContent?.trim()
    || link.getAttribute('title')?.trim() || '';

  const channel = card.querySelector('ytd-channel-name a, .ytd-channel-name a, #text > a, .ytd-video-meta-block a')?.textContent?.trim() || '';

  // Views — first metadata line is usually "X views"
  let views = '';
  const metaSpans = card.querySelectorAll('.inline-metadata-item, #metadata-line span, .ytd-video-meta-block span');
  for (const s of metaSpans) {
    const t = (s.textContent || '').trim();
    if (/^[\d,.KkMmBb]+\s*views?/i.test(t)) {
      views = t.replace(/\s*views?/i, '').trim();
      break;
    }
  }
  return { id, title, channel, views };
}

// ── Auth + endpoint detection ─────────────────────────────────────
async function loadAuthToken() {
  try {
    const r = await chrome.storage.local.get(['tbAuthToken']);
    AUTH_TOKEN = r.tbAuthToken || '';
  } catch { AUTH_TOKEN = ''; }
}

async function saveAuthToken(t) {
  AUTH_TOKEN = t.trim();
  try { await chrome.storage.local.set({ tbAuthToken: AUTH_TOKEN }); } catch {}
}

async function detectServer() {
  try {
    const r = await fetch(`${WORKER_URL}/api/health`, { method:'GET' });
    if (r.ok) { SERVER = WORKER_URL; return; }
  } catch {}
  try {
    const r = await fetch(`${LOCAL_URL}/api/data`, { method:'GET' });
    if (r.ok) { SERVER = LOCAL_URL; return; }
  } catch {}
  SERVER = WORKER_URL;
}

async function tbFetch(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (SERVER === WORKER_URL && (options.method || 'GET').toUpperCase() !== 'GET') {
    if (!AUTH_TOKEN) await loadAuthToken();
    if (AUTH_TOKEN) headers['X-Auth-Token'] = AUTH_TOKEN;
  }
  return fetch(SERVER + path, { ...options, headers });
}

async function refreshSavedIds() {
  try {
    const r = await tbFetch('/api/data');
    const data = await r.json();
    savedVideoIds.clear();
    for (const v of data) savedVideoIds.add(v.id);
    // After refresh, re-style any existing card buttons
    document.querySelectorAll('.tb-card-btn').forEach(b => updateCardBtnState(b, savedVideoIds.has(b.dataset.vid)));
  } catch (e) {
    console.warn('[ThumbnailBoard] could not load saved IDs', e);
  }
}

// ── Thumbnail download + Ollama call ──────────────────────────────
async function fetchThumbnailBase64(videoId) {
  for (const quality of ['maxresdefault', 'mqdefault']) {
    try {
      const r = await fetch(`https://img.youtube.com/vi/${videoId}/${quality}.jpg`);
      if (!r.ok) continue;
      const blob = await r.blob();
      if (blob.size < 2000) continue;  // YouTube's grey placeholder
      return await new Promise((res, rej) => {
        const fr = new FileReader();
        fr.onload = () => res(fr.result.split(',')[1]);
        fr.onerror = rej;
        fr.readAsDataURL(blob);
      });
    } catch {}
  }
  return null;
}

function buildOllamaPrompt(title) {
  return `You are an expert at categorising YouTube thumbnails for a curated reference board.

You must pick tags from this fixed taxonomy. Tags are written as \`category-subtag\` and you may ONLY use these:

${TAXONOMY_STR}

Rules:
- Output a JSON object with one key: "tags" (an array of strings).
- Each string MUST exactly match one from the list above (case-sensitive).
- Choose 3-8 tags total. Be selective: only tags that clearly apply.
- Do NOT invent new tags. Do NOT omit the category prefix.
- No other text outside the JSON.

Example output: {"tags": ["style-colorful", "mood-dramatic", "text-number", "element-celebrity"]}

Video title (context): ${title || '(unknown)'}

Now classify this thumbnail.`;
}

async function callOllama(imageB64, title) {
  const r = await fetch(`${OLLAMA_URL}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: MODEL,
      prompt: buildOllamaPrompt(title),
      images: [imageB64],
      stream: false,
      format: 'json',
      options: { temperature: 0.2 },
    }),
  });
  if (!r.ok) throw new Error(`Ollama HTTP ${r.status}`);
  const j = await r.json();
  const raw = (j.response || '').trim();
  let obj;
  try { obj = JSON.parse(raw); }
  catch {
    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) throw new Error('Ollama returned non-JSON');
    obj = JSON.parse(m[0]);
  }
  if (!obj || !Array.isArray(obj.tags)) throw new Error('Ollama returned no tags array');
  const tags = obj.tags.filter(t => typeof t === 'string' && ALL_VALID.has(t));
  if (!tags.length) throw new Error('No valid tags returned');
  return tags;
}

// ── Generic save flow ─────────────────────────────────────────────
/** Save a video given its scraped info. progress is a callback for UI. */
async function saveVideo(info, progress = () => {}) {
  if (!info || !info.id) throw new Error('No video info');
  // Duplicate check FIRST — saves the 10s Ollama call
  if (savedVideoIds.has(info.id)) {
    throw new Error('Already in board');
  }
  if (saving.has(info.id)) {
    throw new Error('Already saving this one…');
  }
  saving.add(info.id);
  // Auth
  if (SERVER === WORKER_URL && !AUTH_TOKEN) {
    await loadAuthToken();
    if (!AUTH_TOKEN) {
      const t = prompt('Paste your Thumbnail Board access token:');
      if (t) await saveAuthToken(t);
    }
    if (!AUTH_TOKEN) { saving.delete(info.id); throw new Error('Token required'); }
  }
  try {
    progress('Loading thumbnail…');
    const b64 = await fetchThumbnailBase64(info.id);
    if (!b64) throw new Error('Thumbnail not available');

    progress('Analyzing with AI…');
    let tags;
    try { tags = await callOllama(b64, info.title); }
    catch (e) {
      if (String(e).match(/Failed to fetch|NetworkError|ECONNREFUSED/i))
        throw new Error('Ollama not running on localhost:11434');
      throw e;
    }

    progress('Publishing…');
    const r = await tbFetch('/api/add', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...info, tags }),
    });
    const d = await r.json();
    if (d.ok) {
      savedVideoIds.add(info.id);  // update cache
      return tags;
    }
    if (r.status === 401) {
      AUTH_TOKEN = '';
      try { await chrome.storage.local.remove(['tbAuthToken']); } catch {}
      throw new Error('Invalid token — click again to re-enter');
    }
    if (d.msg && /already/i.test(d.msg)) {
      savedVideoIds.add(info.id);
      throw new Error('Already in board');
    }
    throw new Error(d.msg || 'Publish failed');
  } finally {
    saving.delete(info.id);
  }
}

// ── Watch-page floating button ────────────────────────────────────
const ICONS = {
  ai: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m12 3-1.9 5.8a2 2 0 0 1-1.3 1.3L3 12l5.8 1.9a2 2 0 0 1 1.3 1.3L12 21l1.9-5.8a2 2 0 0 1 1.3-1.3L21 12l-5.8-1.9a2 2 0 0 1-1.3-1.3Z"/></svg>',
  spinner: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" class="tb-spin"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>',
  check: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>',
  error: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M15 9l-6 6"/><path d="M9 9l6 6"/></svg>',
  // smaller versions for card buttons
  aiSm: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m12 3-1.9 5.8a2 2 0 0 1-1.3 1.3L3 12l5.8 1.9a2 2 0 0 1 1.3 1.3L12 21l1.9-5.8a2 2 0 0 1 1.3-1.3L21 12l-5.8-1.9a2 2 0 0 1-1.3-1.3Z"/></svg>',
  spinnerSm: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" class="tb-spin"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>',
  checkSm: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>',
};

function setBtnState(state, label) {
  const btn = document.getElementById('tb-btn');
  if (!btn) return;
  btn.className = '';
  btn.dataset.state = state;
  btn.classList.add(`tb-state-${state}`);
  const icon = state === 'loading' ? ICONS.spinner
              : state === 'in-board' ? ICONS.check
              : state === 'error' ? ICONS.error
              : ICONS.ai;
  btn.innerHTML = `${icon}<span>${label}</span>`;
}

async function saveFromWatchPage() {
  const info = getWatchPageInfo();
  if (!info || !info.id) { setBtnState('error', 'No video ID'); return; }
  if (savedVideoIds.has(info.id)) {
    setBtnState('in-board', 'In Board');
    showToast('Already in board', 'success');
    return;
  }
  try {
    const tags = await saveVideo(info, (label) => setBtnState('loading', label));
    setBtnState('in-board', `Saved · ${tags.length} tags`);
    showToast(`Saved with ${tags.length} tags: ${tags.join(', ')}`, 'success');
  } catch (e) {
    if (/already in board/i.test(e.message)) {
      setBtnState('in-board', 'In Board');
      showToast('Already in board', 'success');
    } else {
      setBtnState('error', e.message.slice(0, 60));
      showToast(e.message, 'error');
    }
  }
}

function buildFloatingButton() {
  if (document.getElementById('tb-btn')) return;
  const btn = document.createElement('button');
  btn.id = 'tb-btn';
  document.body.appendChild(btn);
  btn.addEventListener('click', saveFromWatchPage);

  const toast = document.createElement('div');
  toast.id = 'tb-toast';
  document.body.appendChild(toast);

  setBtnState('idle', 'Save with AI');
}

function showToast(msg, type = 'info') {
  const t = document.getElementById('tb-toast');
  if (!t) return;
  t.dataset.type = type;
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.remove('show'), 4000);
}

// ── Per-card hover button (home / search / feed) ──────────────────
function updateCardBtnState(btn, isInBoard, state = null) {
  // state: 'idle' | 'loading' | 'saved' | 'error'
  if (state === 'loading') {
    btn.dataset.state = 'loading';
    btn.innerHTML = ICONS.spinnerSm;
    btn.title = 'Saving…';
    return;
  }
  if (state === 'error') {
    btn.dataset.state = 'error';
    btn.innerHTML = ICONS.error;
    return;
  }
  if (isInBoard || state === 'saved') {
    btn.dataset.state = 'saved';
    btn.innerHTML = ICONS.checkSm;
    btn.title = 'Already in your board';
    return;
  }
  btn.dataset.state = 'idle';
  btn.innerHTML = ICONS.aiSm;
  btn.title = 'Save with AI';
}

function injectCardButton(thumbContainer, watchLink) {
  if (!thumbContainer || !watchLink) return;
  if (thumbContainer.querySelector('.tb-card-btn')) return;  // already injected
  const m = watchLink.href.match(/[?&]v=([A-Za-z0-9_-]{11})/);
  if (!m) return;
  const vid = m[1];

  // Ensure container can position absolutely
  const cs = getComputedStyle(thumbContainer);
  if (cs.position === 'static') thumbContainer.style.position = 'relative';

  const btn = document.createElement('button');
  btn.className = 'tb-card-btn';
  btn.dataset.vid = vid;
  updateCardBtnState(btn, savedVideoIds.has(vid));
  btn.addEventListener('click', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (btn.dataset.state === 'loading') return;
    if (btn.dataset.state === 'saved') {
      showToast('Already in board', 'success');
      return;
    }
    // Find the parent card to extract metadata
    const card = btn.closest('ytd-rich-item-renderer, ytd-video-renderer, ytd-grid-video-renderer, ytd-compact-video-renderer, ytd-rich-grid-media, ytm-shelf-renderer, ytd-reel-item-renderer')
                 || thumbContainer.parentElement;
    const info = getCardInfo(card) || { id: vid, title: '', channel: '', views: '' };
    info.id = vid;
    try {
      updateCardBtnState(btn, false, 'loading');
      const tags = await saveVideo(info);
      updateCardBtnState(btn, true, 'saved');
      showToast(`Saved · ${tags.length} tags`, 'success');
    } catch (err) {
      if (/already in board/i.test(err.message)) {
        updateCardBtnState(btn, true, 'saved');
        showToast('Already in board', 'success');
      } else {
        updateCardBtnState(btn, false, 'error');
        showToast(err.message, 'error');
        setTimeout(() => updateCardBtnState(btn, savedVideoIds.has(vid)), 2500);
      }
    }
  });
  thumbContainer.appendChild(btn);
}

function scanCards() {
  // Find every thumbnail container that holds a /watch link
  const links = document.querySelectorAll('a#thumbnail[href*="/watch?v="], ytd-thumbnail a[href*="/watch?v="]');
  for (const a of links) {
    const container = a.closest('ytd-thumbnail') || a.parentElement;
    if (!container) continue;
    if (/\/shorts\//.test(a.href)) continue;
    injectCardButton(container, a);
  }
}

// ── Init + SPA navigation ─────────────────────────────────────────
function isWatchPage() {
  return location.href.includes('youtube.com/watch');
}

async function init() {
  const existing = document.getElementById('tb-btn');
  if (isWatchPage()) {
    const id = getVideoIdFromWatchPage();
    if (id) currentVideoId = id;
    if (!existing) buildFloatingButton();
    document.getElementById('tb-btn').style.display = '';
    if (id && savedVideoIds.has(id)) setBtnState('in-board', 'In Board');
    else setBtnState('idle', 'Save with AI');
  } else {
    // On feed/home/search the floating button is hidden — card buttons take over
    if (existing) existing.style.display = 'none';
    currentVideoId = null;
  }
  // Always make sure the toast container exists
  if (!document.getElementById('tb-toast')) {
    const toast = document.createElement('div');
    toast.id = 'tb-toast';
    document.body.appendChild(toast);
  }
  scanCards();
}

let lastUrl = location.href;
new MutationObserver(() => {
  if (location.href !== lastUrl) {
    lastUrl = location.href;
    setTimeout(init, 1200);
  }
}).observe(document.body, { childList: true, subtree: true });

document.addEventListener('yt-navigate-finish', () => setTimeout(init, 600));

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'TB_URL_CHANGED') {
    if (msg.url) {
      const m = msg.url.match(/[?&]v=([A-Za-z0-9_-]{11})/);
      if (m) currentVideoId = m[1];
    }
    setTimeout(init, 600);
  }
});

// Continuously discover new cards as the user scrolls
const cardObserver = new MutationObserver(() => {
  // Debounce to avoid hammering on every micro-mutation
  if (cardObserver._t) return;
  cardObserver._t = setTimeout(() => {
    cardObserver._t = null;
    scanCards();
  }, 250);
});
cardObserver.observe(document.body, { childList: true, subtree: true });

// Kick off
(async () => {
  await Promise.all([detectServer(), loadAuthToken()]);
  await refreshSavedIds();
  setTimeout(init, 1200);
})();
