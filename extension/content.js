// ── Thumbnail Board Extension ─────────────────────────────────────
// Tries Cloudflare Worker first, falls back to localhost if unreachable.
// CHANGE WORKER_URL after deploying the Worker.
const WORKER_URL = 'https://thumbnail-board-api.andrei-nndd.workers.dev';
const LOCAL_URL  = 'http://localhost:3000';
let SERVER = WORKER_URL;  // updated by health check below
let AUTH_TOKEN = '';      // loaded from chrome.storage

const CATS = {
  STYLE:     { color:'#e94560', bg:'#533483', subs:['colorful','high-contrast','minimal','split-screen','illustration','handdrawn','3d','photoshopped','collage','anatomy','busy','match-split','monochrome','pattern','dissolving','photo-composite'] },
  MOOD:      { color:'#4caf50', bg:'#2d6a2d', subs:['dramatic','happy','serious','entertaining','confused','exhausted','frustrated','sad','surprised','skeptical'] },
  TEXT:      { color:'#7c4dff', bg:'#4527a0', subs:['identity','callout','question','normative-claim','number','quote','forward-referencing','cta','in-center','in-background','direct-address','chat','answer'] },
  ELEMENT:   { color:'#ff6d00', bg:'#bf360c', subs:['celebrity','graphic','chart','unusual','glow','logo','screen','money','in-background','fire','hand','in-foreground','in-motion','obfuscation','eye','map','vehicle','pile','damage','animal','food','book','brain','crowd','emoji','notification','checkbox','review','building'] },
  CAMERA:    { color:'#00bcd4', bg:'#006064', subs:['medium-shot','close-up','overhead-shot','full-shot','aerial-shot','back-shot','unusual'] },
  SUBJECT:   { color:'#ffab40', bg:'#e65100', subs:['in-motion','holding-object','count-two','count-many','in-background','unusual-pose','talking','laying','sitting','clone'] },
  FORMATION: { color:'#ab47bc', bg:'#6a1b9a', subs:['flat-lay','line','grid','v'] },
  TOPIC:     { color:'#26a69a', bg:'#004d40', subs:['comparison','product-showcase','space','secret','social-media','size'] },
  CALLOUT:   { color:'#d4e157', bg:'#827717', subs:['magnifier'] },
  BACKDROP:  { color:'#ec407a', bg:'#880e4f', subs:['dark','light','blurry'] },
  CHANNEL:   { color:'#00bcd4', bg:'#006064', subs:['theseniordev-main','theseniordev-podcast'] },
};

let selected = new Set();
let videoData = { id:'', title:'', channel:'', views:'' };
let panelOpen = false;
let currentVideoId = null; // set by init() when successfully detected

function getVideoId() {
  const RE = /[?&]v=([A-Za-z0-9_-]{11})|\/shorts\/([A-Za-z0-9_-]{11})/;

  // 1. YouTube DOM element — most reliable, doesn't depend on URL parsing
  const watchEl = document.querySelector('ytd-watch-flexy, ytd-watch-two');
  if (watchEl) {
    const vid = watchEl.getAttribute('video-id');
    if (vid) return vid;
  }

  // 2. URL parameter
  let m = location.href.match(RE);
  if (m) return m[1] || m[2];

  // 3. document.URL
  m = document.URL.match(RE);
  if (m) return m[1] || m[2];

  // 4. canonical link tag
  const canonical = document.querySelector('link[rel="canonical"]');
  if (canonical?.href) {
    m = canonical.href.match(RE);
    if (m) return m[1] || m[2];
  }

  // 5. og:url meta tag
  const ogUrl = document.querySelector('meta[property="og:url"]');
  if (ogUrl?.content) {
    m = ogUrl.content.match(RE);
    if (m) return m[1] || m[2];
  }

  // 6. Last resort: ID stored when init() last ran successfully
  if (currentVideoId) return currentVideoId;

  return null;
}

function getVideoInfo() {
  const id = getVideoId();
  if (!id) return null;
  const title = document.querySelector('h1.ytd-video-primary-info-renderer yt-formatted-string, h1 yt-formatted-string.ytd-watch-metadata')?.textContent?.trim()
    || document.title.replace(' - YouTube','').trim();
  const channel = document.querySelector('ytd-channel-name yt-formatted-string a, #channel-name a')?.textContent?.trim() || '';
  // Read viewCount from YouTube's embedded JSON data — immune to DOM changes
  let views = '';
  try {
    for (const script of document.querySelectorAll('script:not([src])')) {
      const t = script.textContent;
      if (!t.includes('viewCount')) continue;
      const m = t.match(/"viewCount"\s*:\s*"(\d+)"/);
      if (m) {
        const n = parseInt(m[1], 10);
        if (n >= 1000000)      views = (n / 1000000).toFixed(1).replace(/\.0$/, '') + 'M';
        else if (n >= 1000)    views = (n / 1000).toFixed(1).replace(/\.0$/, '') + 'K';
        else                   views = n.toString();
        break;
      }
    }
  } catch {}
  // Fallback: dedicated renderer element
  if (!views) {
    const el = document.querySelector('ytd-video-view-count-renderer span');
    if (el) views = el.textContent.trim().replace(/\s*views?/i,'').trim();
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

/** Pick best reachable endpoint. Tries Worker, falls back to localhost. */
async function detectServer() {
  try {
    const r = await fetch(`${WORKER_URL}/api/health`, { method:'GET' });
    if (r.ok) { SERVER = WORKER_URL; return; }
  } catch {}
  try {
    const r = await fetch(`${LOCAL_URL}/api/data`, { method:'GET' });
    if (r.ok) { SERVER = LOCAL_URL; return; }
  } catch {}
  // Default to worker if neither responded (server.py might still be starting)
  SERVER = WORKER_URL;
}

/** Wrapper around fetch that adds auth header when targeting the Worker. */
async function tbFetch(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (SERVER === WORKER_URL && (options.method || 'GET').toUpperCase() !== 'GET') {
    if (!AUTH_TOKEN) await loadAuthToken();
    if (AUTH_TOKEN) headers['X-Auth-Token'] = AUTH_TOKEN;
  }
  return fetch(SERVER + path, { ...options, headers });
}

async function checkInBoard(id) {
  try {
    // Always read data.json from the public GitHub Pages (or local server) — no auth needed
    const r = await tbFetch(`/api/data`);
    const data = await r.json();
    return data.some(v => v.id === id);
  } catch { return false; }
}

// ── Build UI ──────────────────────────────────────────────────────
function buildPanel() {
  const btn = document.createElement('button');
  btn.id = 'tb-btn';
  btn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M19 3H5c-1.1 0-2 .9-2 2v14l7-3 7 3V5c0-1.1-.9-2-2-2z"/></svg> Save to Board`;
  document.body.appendChild(btn);

  const panel = document.createElement('div');
  panel.id = 'tb-panel';
  panel.innerHTML = `
    <div id="tb-panel-header">
      <div class="tb-logo">THUMBNAIL<span>BOARD</span></div>
      <button id="tb-close">×</button>
    </div>
    <div id="tb-thumb-row">
      <img id="tb-thumb" src="" alt="">
      <div class="tb-meta">
        <div class="tb-title" id="tb-title"></div>
        <div class="tb-channel" id="tb-channel"></div>
      </div>
    </div>
    <div id="tb-tags-scroll"></div>
    <div id="tb-sel-preview"><span class="tb-empty-sel">No tags selected</span></div>
    <div id="tb-panel-footer">
      <button id="tb-cancel-btn">Cancel</button>
      <button id="tb-save-btn" disabled>Save to Board</button>
    </div>`;
  document.body.appendChild(panel);

  const toast = document.createElement('div');
  toast.id = 'tb-toast';
  document.body.appendChild(toast);

  buildTagPanel();

  // Event listeners (no inline onclick — required for content scripts)
  btn.addEventListener('click', () => togglePanel());
  document.getElementById('tb-close').addEventListener('click', closePanel);
  document.getElementById('tb-cancel-btn').addEventListener('click', closePanel);
  document.getElementById('tb-save-btn').addEventListener('click', saveToBoard);
}

function buildTagPanel() {
  const scroll = document.getElementById('tb-tags-scroll');
  scroll.innerHTML = '';

  Object.entries(CATS).forEach(([cat, cfg]) => {
    const sec = document.createElement('div');
    sec.className = 'tb-cat-section';

    // Title row
    const titleRow = document.createElement('div');
    titleRow.className = 'tb-cat-title';
    titleRow.innerHTML = `<span class="tb-cat-dot" style="background:${cfg.color}"></span>${cat}`;
    const addBtn = document.createElement('button');
    addBtn.className = 'tb-cat-add-btn';
    addBtn.textContent = '+ add';
    addBtn.addEventListener('click', () => toggleCustomInput(cat));
    titleRow.appendChild(addBtn);
    sec.appendChild(titleRow);

    // Tag grid
    const grid = document.createElement('div');
    grid.className = 'tb-tag-grid';
    grid.id = `tb-grid-${cat}`;
    cfg.subs.forEach(sub => {
      const tag = `${cat.toLowerCase()}-${sub}`;
      const tagBtn = document.createElement('button');
      tagBtn.className = 'tb-tag-btn';
      tagBtn.dataset.tag = tag;
      tagBtn.textContent = sub;
      tagBtn.addEventListener('click', () => toggleTag(tag, tagBtn, cfg.bg, cfg.color));
      grid.appendChild(tagBtn);
    });
    sec.appendChild(grid);

    // Custom input row
    const customRow = document.createElement('div');
    customRow.className = 'tb-custom-row';
    customRow.id = `tb-custom-${cat}`;
    const inp = document.createElement('input');
    inp.className = 'tb-custom-inp';
    inp.id = `tb-inp-${cat}`;
    inp.placeholder = 'e.g. neon';
    inp.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); addCustomTag(cat); }
      e.stopPropagation();
    });
    const addTagBtn = document.createElement('button');
    addTagBtn.className = 'tb-custom-add';
    addTagBtn.textContent = 'Add';
    addTagBtn.addEventListener('click', () => addCustomTag(cat));
    customRow.appendChild(inp);
    customRow.appendChild(addTagBtn);
    sec.appendChild(customRow);

    scroll.appendChild(sec);
  });
}

function toggleCustomInput(cat) {
  const row = document.getElementById(`tb-custom-${cat}`);
  const inp = document.getElementById(`tb-inp-${cat}`);
  const open = row.classList.toggle('open');
  if (open) inp.focus();
}

function addCustomTag(cat) {
  const inp = document.getElementById(`tb-inp-${cat}`);
  const raw = inp.value.trim().toLowerCase().replace(/\s+/g,'-');
  if (!raw) return;
  const tag = `${cat.toLowerCase()}-${raw}`;
  const grid = document.getElementById(`tb-grid-${cat}`);
  if (!grid.querySelector(`[data-tag="${tag}"]`)) {
    const cfg = CATS[cat];
    const tagBtn = document.createElement('button');
    tagBtn.className = 'tb-tag-btn';
    tagBtn.dataset.tag = tag;
    tagBtn.textContent = raw;
    tagBtn.addEventListener('click', () => toggleTag(tag, tagBtn, cfg.bg, cfg.color));
    grid.appendChild(tagBtn);
  }
  const btn = grid.querySelector(`[data-tag="${tag}"]`);
  if (btn && !selected.has(tag)) toggleTag(tag, btn, CATS[cat].bg, CATS[cat].color);
  inp.value = '';
  document.getElementById(`tb-custom-${cat}`).classList.remove('open');
}

function toggleTag(tag, btn, bg, color) {
  if (selected.has(tag)) {
    selected.delete(tag);
    btn.classList.remove('sel');
    btn.style.cssText = '';
  } else {
    selected.add(tag);
    btn.classList.add('sel');
    btn.style.background = bg;
    btn.style.color = '#fff';
    btn.style.borderColor = 'transparent';
  }
  refreshPreview();
}

function untagSelected(tag) {
  selected.delete(tag);
  const btn = document.querySelector(`.tb-tag-btn[data-tag="${tag}"]`);
  if (btn) { btn.classList.remove('sel'); btn.style.cssText = ''; }
  refreshPreview();
}

function refreshPreview() {
  const preview = document.getElementById('tb-sel-preview');
  if (!selected.size) {
    preview.innerHTML = '<span class="tb-empty-sel">No tags selected</span>';
  } else {
    preview.innerHTML = [...selected].map(t => {
      const cat = t.split('-')[0].toUpperCase();
      const cfg = CATS[cat] || { bg:'#333' };
      return `<span class="tb-sel-tag" style="background:${cfg.bg}">${t} <span class="tb-sel-x" data-untag="${t}">×</span></span>`;
    }).join('');
    // Attach untag listeners
    preview.querySelectorAll('.tb-sel-x').forEach(x => {
      x.addEventListener('click', () => untagSelected(x.dataset.untag));
    });
  }
  document.getElementById('tb-save-btn').disabled = selected.size === 0;
}

async function togglePanel() {
  if (panelOpen) { closePanel(); return; }

  // If local detection fails, ask background.js for the confirmed tab URL
  let info = getVideoInfo();
  if (!info || !info.id) {
    try {
      const resp = await new Promise((resolve, reject) => {
        chrome.runtime.sendMessage({ type: 'TB_GET_URL' }, r => {
          if (chrome.runtime.lastError) reject(chrome.runtime.lastError);
          else resolve(r);
        });
      });
      if (resp?.url) {
        const m = resp.url.match(/[?&]v=([A-Za-z0-9_-]{11})/);
        if (m) { currentVideoId = m[1]; info = getVideoInfo(); }
      }
    } catch {}
  }

  if (!info || !info.id) {
    showToast('❌ Could not detect video ID — try refreshing the page');
    return;
  }
  videoData = info;
  document.getElementById('tb-thumb').src = `https://img.youtube.com/vi/${videoData.id}/maxresdefault.jpg`;
  document.getElementById('tb-title').textContent = videoData.title;
  document.getElementById('tb-channel').textContent = videoData.channel;
  selected.clear();
  document.querySelectorAll('.tb-tag-btn.sel').forEach(b => { b.classList.remove('sel'); b.style.cssText = ''; });
  refreshPreview();
  document.getElementById('tb-panel').classList.add('open');
  panelOpen = true;
}

function closePanel() {
  document.getElementById('tb-panel').classList.remove('open');
  panelOpen = false;
}

async function saveToBoard() {
  if (!selected.size) return;
  const btn = document.getElementById('tb-save-btn');
  btn.disabled = true; btn.textContent = 'Saving…';
  // Ensure we have an auth token if we're hitting the cloud Worker
  if (SERVER === WORKER_URL && !AUTH_TOKEN) {
    await loadAuthToken();
    if (!AUTH_TOKEN) {
      const t = prompt('Paste your Thumbnail Board access token:');
      if (t) await saveAuthToken(t);
    }
    if (!AUTH_TOKEN) {
      showToast('❌ No access token — get one from your board owner');
      btn.disabled = false; btn.textContent = 'Save to Board';
      return;
    }
  }
  try {
    const r = await tbFetch(`/api/add`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...videoData, tags: [...selected] })
    });
    const d = await r.json();
    if (d.ok) {
      showToast(`✅ Saved with ${selected.size} tags!`);
      closePanel();
      const floatBtn = document.getElementById('tb-btn');
      floatBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg> In Board`;
      floatBtn.classList.add('in-board');
    } else if (r.status === 401) {
      AUTH_TOKEN = '';
      try { await chrome.storage.local.remove(['tbAuthToken']); } catch {}
      showToast('❌ Invalid token — try Save again to re-enter it');
    } else {
      showToast(`❌ ${d.msg || 'Error saving'}`);
    }
  } catch(e) {
    showToast('❌ Cannot reach server');
  } finally {
    btn.disabled = false; btn.textContent = 'Save to Board';
  }
}

function showToast(msg) {
  const t = document.getElementById('tb-toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.remove('show'), 3500);
}

function isWatchPage() {
  return location.href.includes('youtube.com/watch');
}

function init() {
  const existing = document.getElementById('tb-btn');
  if (!isWatchPage()) {
    // Hide button and clear state when navigating away from a video page
    if (existing) existing.style.display = 'none';
    if (panelOpen) closePanel();
    currentVideoId = null;
    return;
  }
  const id = getVideoId();
  if (!id) return;
  currentVideoId = id; // store for use in togglePanel()

  // Show button (it may have been hidden)
  if (existing) existing.style.display = '';
  if (existing) {
    // Already injected — just update state
    existing.classList.remove('in-board');
    existing.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M19 3H5c-1.1 0-2 .9-2 2v14l7-3 7 3V5c0-1.1-.9-2-2-2z"/></svg> Save to Board`;
    if (panelOpen) closePanel();
  } else {
    buildPanel();
  }

  checkInBoard(id).then(inBoard => {
    const btn = document.getElementById('tb-btn');
    if (!btn) return;
    if (inBoard) {
      btn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg> In Board`;
      btn.classList.add('in-board');
    }
  });
}

// Handle SPA navigation via URL changes
let lastUrl = location.href;
new MutationObserver(() => {
  if (location.href !== lastUrl) {
    lastUrl = location.href;
    setTimeout(init, 1500);
  }
}).observe(document.body, { childList: true, subtree: true });

// Also listen for YouTube's custom navigation event
document.addEventListener('yt-navigate-finish', () => setTimeout(init, 800));

// Listen for URL change messages from background.js
// background.js sends the confirmed tab URL so we can cache it
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'TB_URL_CHANGED') {
    if (msg.url) {
      const m = msg.url.match(/[?&]v=([A-Za-z0-9_-]{11})/);
      if (m) currentVideoId = m[1];
    }
    setTimeout(init, 800);
  }
});

// Kick off: detect best endpoint + load token, then init
(async () => {
  await Promise.all([detectServer(), loadAuthToken()]);
  setTimeout(init, 1500);
})();
