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
  // hqdefault is 480x360 ~30KB — Ollama inference is much faster than
  // sending maxresdefault (1280x720 ~80KB). Quality is enough for tag
  // detection. Fall back to mqdefault, then maxres if both fail.
  for (const quality of ['hqdefault', 'mqdefault', 'maxresdefault']) {
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
  refreshQueueIndicator();
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
    refreshQueueIndicator();
  }
}

/** Persistent bottom-right indicator showing how many saves are in flight.
 *  Visible across SPA navigation so you know stuff is still happening even
 *  when you scroll/navigate away from the card you clicked. */
function refreshQueueIndicator() {
  const n = saving.size;
  let el = document.getElementById('tb-queue');
  if (n === 0) { el?.remove(); return; }
  if (!el) {
    el = document.createElement('div');
    el.id = 'tb-queue';
    document.body.appendChild(el);
  }
  el.innerHTML = `${ICONS.spinnerSm}<span>Saving ${n}…</span>`;
}

// ── Watch-page floating button ────────────────────────────────────
const ICONS = {
  ai: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m12 3-1.9 5.8a2 2 0 0 1-1.3 1.3L3 12l5.8 1.9a2 2 0 0 1 1.3 1.3L12 21l1.9-5.8a2 2 0 0 1 1.3-1.3L21 12l-5.8-1.9a2 2 0 0 1-1.3-1.3Z"/></svg>',
  spinner: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" class="tb-spin"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>',
  check: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>',
  error: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M15 9l-6 6"/><path d="M9 9l6 6"/></svg>',
  // smaller versions for card buttons
  aiSm: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m12 3-1.9 5.8a2 2 0 0 1-1.3 1.3L3 12l5.8 1.9a2 2 0 0 1 1.3 1.3L12 21l1.9-5.8a2 2 0 0 1 1.3-1.3L21 12l-5.8-1.9a2 2 0 0 1-1.3-1.3Z"/></svg>',
  spinnerSm: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" class="tb-spin"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>',
  checkSm: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>',
  // Dropdown menu icons
  download:  '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>',
  external:  '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>',
  trash:     '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>',
  edit:      '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>',
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

// ── Dropdown menu ─────────────────────────────────────────────────
let _openMenu = null;

function closeMenu() {
  if (_openMenu) { _openMenu.remove(); _openMenu = null; }
  document.removeEventListener('click', _onDocClickClose, true);
  document.removeEventListener('scroll', closeMenu, true);
  window.removeEventListener('resize', closeMenu, true);
}
function _onDocClickClose(e) {
  if (_openMenu && !_openMenu.contains(e.target) && !e.target.closest('.tb-card-btn')) closeMenu();
}

function openMenu(btn, info) {
  closeMenu();
  const menu = document.createElement('div');
  menu.className = 'tb-card-menu';
  const isSaved = savedVideoIds.has(info.id);
  menu.innerHTML = `
    ${isSaved
      ? `<button class="tb-mi tb-mi-disabled"><span class="tb-mi-ic">${ICONS.checkSm}</span><span>Already in your board</span></button>`
      : `<button class="tb-mi tb-mi-primary" data-act="save"><span class="tb-mi-ic">${ICONS.aiSm}</span><span>Save with AI</span></button>`
    }
    <button class="tb-mi" data-act="download"><span class="tb-mi-ic">${ICONS.download}</span><span>Download thumbnail</span></button>
    <button class="tb-mi" data-act="open"><span class="tb-mi-ic">${ICONS.external}</span><span>Open thumbnail (max res)</span></button>
    ${isSaved
      ? `<button class="tb-mi tb-mi-danger" data-act="delete"><span class="tb-mi-ic">${ICONS.trash}</span><span>Remove from board</span></button>`
      : ''
    }
  `;
  document.body.appendChild(menu);
  _openMenu = menu;

  // Position next to the button — try right side first, flip to left if no room
  const r = btn.getBoundingClientRect();
  menu.style.visibility = 'hidden';
  menu.style.top = '0'; menu.style.left = '0';
  // We use fixed positioning so it floats above YouTube's overlays
  const mw = menu.offsetWidth;
  const mh = menu.offsetHeight;
  // Button is now at the bottom-right of the card — open the menu
  // UPWARDS and align its right edge with the button's right edge.
  let top  = r.top - mh - 6;
  let left = r.right - mw;
  // Flip downwards if there's no room above
  if (top < 8) top = r.bottom + 6;
  // Keep within viewport horizontally
  if (left < 8) left = 8;
  if (left + mw > window.innerWidth - 8) left = window.innerWidth - mw - 8;
  if (top + mh > window.innerHeight - 8) top = window.innerHeight - mh - 8;
  menu.style.top  = `${top}px`;
  menu.style.left = `${left}px`;
  menu.style.visibility = 'visible';
  requestAnimationFrame(() => menu.classList.add('open'));

  menu.addEventListener('click', async (e) => {
    const item = e.target.closest('[data-act]');
    if (!item) return;
    const act = item.dataset.act;
    closeMenu();
    if (act === 'save')      await runSave(btn, info);
    if (act === 'download')  downloadThumbnail(info.id, info.title);
    if (act === 'open')      window.open(`https://img.youtube.com/vi/${info.id}/maxresdefault.jpg`, '_blank');
    if (act === 'delete')    await removeFromBoard(btn, info);
  });
  setTimeout(() => {
    document.addEventListener('click', _onDocClickClose, true);
    document.addEventListener('scroll', closeMenu, true);
    window.addEventListener('resize', closeMenu, true);
  }, 0);
}

async function runSave(btn, info) {
  if (btn.dataset.state === 'loading') return;
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
      setTimeout(() => updateCardBtnState(btn, savedVideoIds.has(info.id)), 2500);
    }
  }
}

async function removeFromBoard(btn, info) {
  if (!confirm(`Remove "${info.title || info.id}" from the board?`)) return;
  try {
    const r = await tbFetch('/api/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: info.id }),
    });
    const d = await r.json();
    if (d.ok || /not found/i.test(d.msg || '')) {
      savedVideoIds.delete(info.id);
      updateCardBtnState(btn, false);
      showToast('Removed from board', 'success');
    } else {
      showToast(d.msg || 'Delete failed', 'error');
    }
  } catch (e) {
    showToast(e.message, 'error');
  }
}

async function downloadThumbnail(videoId, title) {
  try {
    const r = await fetch(`https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`);
    if (!r.ok) throw new Error('not available');
    const blob = await r.blob();
    if (blob.size < 2000) throw new Error('not available');
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const safe = (title || videoId).replace(/[^a-z0-9\-_]+/gi, '_').slice(0, 80);
    a.download = `${safe}_${videoId}.jpg`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 3000);
    showToast('Thumbnail downloaded', 'success');
  } catch (e) {
    showToast('Could not download — try mqdefault', 'error');
  }
}

// ── Per-card button injection ─────────────────────────────────────
function injectCardButton(thumbContainer, watchLink) {
  if (!thumbContainer || !watchLink) return;
  if (thumbContainer.querySelector('.tb-card-btn')) return;
  const m = watchLink.href.match(/[?&]v=([A-Za-z0-9_-]{11})/);
  if (!m) return;
  const vid = m[1];

  const cs = getComputedStyle(thumbContainer);
  if (cs.position === 'static') thumbContainer.style.position = 'relative';

  const btn = document.createElement('button');
  btn.className = 'tb-card-btn';
  btn.dataset.vid = vid;
  btn.title = 'Thumbnail Board';
  updateCardBtnState(btn, savedVideoIds.has(vid));
  btn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (btn.dataset.state === 'loading') return;
    // Find the surrounding card to extract metadata
    const card = btn.closest(
      'ytd-rich-item-renderer, ytd-video-renderer, ytd-grid-video-renderer, ' +
      'ytd-compact-video-renderer, ytd-rich-grid-media, ytd-reel-item-renderer, ' +
      'yt-lockup-view-model, ytm-rich-item-renderer'
    ) || thumbContainer.parentElement;
    const info = getCardInfo(card) || { id: vid, title: '', channel: '', views: '' };
    info.id = vid;
    openMenu(btn, info);
  });
  thumbContainer.appendChild(btn);
}

function scanCards() {
  // Strategy: find every /watch?v= anchor that actually wraps a thumbnail
  // (has an image-like element inside). Skip shorts.
  const links = document.querySelectorAll('a[href*="/watch?v="]');
  for (const a of links) {
    if (/\/shorts\//.test(a.href)) continue;
    // Only treat as a thumbnail link if it contains an image-bearing element
    if (!a.querySelector('img, yt-image, yt-thumbnail-view-model, .yt-core-image, .shortsLockupViewModelHostThumbnailContainer')) continue;
    const container = a.closest('ytd-thumbnail') || a;
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
