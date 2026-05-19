// ── Thumbnail Board Extension ─────────────────────────────────────
const SERVER = 'http://localhost:3000';

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

// ── Get video info from page ──────────────────────────────────────
function getVideoId() {
  const m = location.href.match(/[?&]v=([A-Za-z0-9_-]{11})/);
  return m ? m[1] : null;
}

function getVideoInfo() {
  const id = getVideoId();
  if (!id) return null;
  const title = document.querySelector('h1.ytd-video-primary-info-renderer yt-formatted-string, h1.style-scope.ytd-video-primary-info-renderer')?.textContent?.trim()
    || document.title.replace(' - YouTube','').trim();
  const channel = document.querySelector('#channel-name a, ytd-channel-name a, #owner #channel-name')?.textContent?.trim() || '';
  const viewsEl = document.querySelector('#info-strings yt-formatted-string, #info span');
  const views = viewsEl?.textContent?.trim().replace(/\s*views?/i,'') || '';
  return { id, title, channel, views };
}

// ── Check if already in board ─────────────────────────────────────
async function checkInBoard(id) {
  try {
    const r = await fetch(`${SERVER}/api/data`);
    const data = await r.json();
    return data.some(v => v.id === id);
  } catch { return false; }
}

// ── Build UI ──────────────────────────────────────────────────────
function buildPanel() {
  // Floating button
  const btn = document.createElement('button');
  btn.id = 'tb-btn';
  btn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M4 6h16v2H4zm0 5h16v2H4zm0 5h16v2H4z"/></svg> Save to Board`;
  btn.onclick = () => togglePanel();
  document.body.appendChild(btn);

  // Panel
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

  // Toast
  const toast = document.createElement('div');
  toast.id = 'tb-toast';
  document.body.appendChild(toast);

  document.getElementById('tb-close').onclick = () => closePanel();
  document.getElementById('tb-cancel-btn').onclick = () => closePanel();
  document.getElementById('tb-save-btn').onclick = () => saveToBoard();

  buildTagPanel();
}

function buildTagPanel() {
  const scroll = document.getElementById('tb-tags-scroll');
  scroll.innerHTML = '';
  Object.entries(CATS).forEach(([cat, cfg]) => {
    const subs = cfg.subs.map(sub => {
      const tag = `${cat.toLowerCase()}-${sub}`;
      return `<button class="tb-tag-btn" data-tag="${tag}"
        onclick="tbToggle('${tag}',this,'${cfg.bg}','${cfg.color}')">${sub}</button>`;
    }).join('');
    const sec = document.createElement('div');
    sec.className = 'tb-cat-section';
    sec.innerHTML = `
      <div class="tb-cat-title">
        <span class="tb-cat-dot" style="background:${cfg.color}"></span>${cat}
        <button class="tb-cat-add-btn" onclick="tbToggleInput('${cat}')">+ add</button>
      </div>
      <div class="tb-tag-grid" id="tb-grid-${cat}">${subs}</div>
      <div class="tb-custom-row" id="tb-custom-${cat}">
        <input class="tb-custom-inp" id="tb-inp-${cat}" placeholder="e.g. neon"
          onkeydown="if(event.key==='Enter'){tbAddCustom('${cat}');event.preventDefault();}">
        <button class="tb-custom-add" onclick="tbAddCustom('${cat}')">Add</button>
      </div>`;
    scroll.appendChild(sec);
  });
}

// ── Tag functions (global so onclick works) ───────────────────────
window.tbToggle = function(tag, btn, bg, color) {
  if (selected.has(tag)) {
    selected.delete(tag);
    btn.classList.remove('sel'); btn.style.cssText = '';
  } else {
    selected.add(tag);
    btn.classList.add('sel');
    btn.style.background = bg; btn.style.color = '#fff'; btn.style.borderColor = 'transparent';
  }
  refreshPreview();
};

window.tbToggleInput = function(cat) {
  const row = document.getElementById(`tb-custom-${cat}`);
  const inp = document.getElementById(`tb-inp-${cat}`);
  const open = row.classList.toggle('open');
  if (open) inp.focus();
};

window.tbAddCustom = function(cat) {
  const inp = document.getElementById(`tb-inp-${cat}`);
  const raw = inp.value.trim().toLowerCase().replace(/\s+/g,'-');
  if (!raw) return;
  const tag = `${cat.toLowerCase()}-${raw}`;
  const grid = document.getElementById(`tb-grid-${cat}`);
  if (!grid.querySelector(`[data-tag="${tag}"]`)) {
    const cfg = CATS[cat];
    const btn = document.createElement('button');
    btn.className = 'tb-tag-btn';
    btn.dataset.tag = tag;
    btn.textContent = raw;
    btn.onclick = () => tbToggle(tag, btn, cfg.bg, cfg.color);
    grid.appendChild(btn);
  }
  const btn = grid.querySelector(`[data-tag="${tag}"]`);
  if (btn && !selected.has(tag)) tbToggle(tag, btn, CATS[cat].bg, CATS[cat].color);
  inp.value = '';
  document.getElementById(`tb-custom-${cat}`).classList.remove('open');
};

function refreshPreview() {
  const preview = document.getElementById('tb-sel-preview');
  if (!selected.size) {
    preview.innerHTML = '<span class="tb-empty-sel">No tags selected</span>';
  } else {
    preview.innerHTML = [...selected].map(t => {
      const cat = t.split('-')[0].toUpperCase();
      const cfg = CATS[cat] || { bg:'#333' };
      return `<span class="tb-sel-tag" style="background:${cfg.bg}">${t}
        <span class="tb-sel-x" onclick="tbUntag('${t}')">×</span></span>`;
    }).join('');
  }
  document.getElementById('tb-save-btn').disabled = selected.size === 0;
}

window.tbUntag = function(tag) {
  selected.delete(tag);
  const btn = document.querySelector(`.tb-tag-btn[data-tag="${tag}"]`);
  if (btn) { btn.classList.remove('sel'); btn.style.cssText = ''; }
  refreshPreview();
};

// ── Panel open/close ──────────────────────────────────────────────
async function togglePanel() {
  if (panelOpen) { closePanel(); return; }
  videoData = getVideoInfo() || videoData;
  // Update panel content
  document.getElementById('tb-thumb').src = `https://img.youtube.com/vi/${videoData.id}/maxresdefault.jpg`;
  document.getElementById('tb-title').textContent = videoData.title;
  document.getElementById('tb-channel').textContent = videoData.channel;
  // Reset tags
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

// ── Save ──────────────────────────────────────────────────────────
async function saveToBoard() {
  if (!selected.size) return;
  const btn = document.getElementById('tb-save-btn');
  btn.disabled = true; btn.textContent = 'Saving…';
  try {
    const r = await fetch(`${SERVER}/api/add`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...videoData, tags: [...selected] })
    });
    const d = await r.json();
    if (d.ok) {
      showToast(`✅ Saved to board with ${selected.size} tags!`);
      closePanel();
      // Update button state
      const floatBtn = document.getElementById('tb-btn');
      floatBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg> In Board`;
      floatBtn.classList.add('in-board');
    } else {
      showToast(`❌ ${d.msg || 'Error saving'}`);
    }
  } catch(e) {
    showToast('❌ Cannot reach server — make sure tagger.command is running');
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

// ── Init (re-runs on YouTube SPA navigation) ──────────────────────
function init() {
  const id = getVideoId();
  if (!id) return;
  if (document.getElementById('tb-btn')) {
    // Update existing button on navigation
    const btn = document.getElementById('tb-btn');
    btn.classList.remove('in-board');
    btn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M4 6h16v2H4zm0 5h16v2H4zm0 5h16v2H4z"/></svg> Save to Board`;
    checkInBoard(id).then(inBoard => {
      if (inBoard) {
        btn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg> In Board`;
        btn.classList.add('in-board');
      }
    });
    return;
  }
  buildPanel();
  checkInBoard(id).then(inBoard => {
    if (inBoard) {
      const btn = document.getElementById('tb-btn');
      btn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg> In Board`;
      btn.classList.add('in-board');
    }
  });
}

// Handle YouTube SPA navigation
let lastUrl = location.href;
const observer = new MutationObserver(() => {
  if (location.href !== lastUrl) {
    lastUrl = location.href;
    setTimeout(init, 1500); // wait for page to load
  }
});
observer.observe(document.body, { childList: true, subtree: true });

// Initial run
setTimeout(init, 1500);
