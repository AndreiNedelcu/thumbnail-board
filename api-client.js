/**
 * Thumbnail Board — unified API client
 *
 * Auto-detects environment:
 *   - localhost  → calls /api/* on the local Python server
 *   - elsewhere  → calls the Cloudflare Worker
 *
 * Handles auth: pulls AUTH_TOKEN from localStorage and adds it to every
 * write request. Shows a one-time login overlay if missing.
 */
(function () {
  // CHANGE THIS after deploying the Worker — the URL wrangler prints.
  // Until then, the cloud fallback won't be reachable.
  const WORKER_URL = 'https://thumbnail-board-api.theseniordev.workers.dev';

  const isLocal = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
  const API_BASE = isLocal ? '' : WORKER_URL;

  function getToken() {
    return localStorage.getItem('tb-auth-token') || '';
  }

  function setToken(t) {
    if (t) localStorage.setItem('tb-auth-token', t.trim());
    else localStorage.removeItem('tb-auth-token');
  }

  /** Fetch wrapper that adds auth header (unless reading) and points at the
   *  right base URL. Returns a Response. */
  async function tbFetch(path, options = {}) {
    const isWrite = (options.method || 'GET').toUpperCase() !== 'GET';
    const headers = { ...(options.headers || {}) };
    if (isWrite && !isLocal) {
      const tok = getToken();
      if (!tok) {
        showLoginOverlay();
        throw new Error('No auth token — please log in');
      }
      headers['X-Auth-Token'] = tok;
    }
    return fetch(API_BASE + path, { ...options, headers });
  }

  // ── Login overlay ──────────────────────────────────────────────
  function showLoginOverlay() {
    if (document.getElementById('tb-login-overlay')) return;
    const ov = document.createElement('div');
    ov.id = 'tb-login-overlay';
    ov.innerHTML = `
      <style>
        #tb-login-overlay { position:fixed; inset:0; z-index:9999; background:rgba(13,17,23,0.92); backdrop-filter:blur(20px); display:flex; align-items:center; justify-content:center; font-family:'Inter',sans-serif; }
        .tb-login-box { background:#171e25; border:1px solid rgba(204,218,231,0.08); border-radius:16px; padding:32px; max-width:420px; width:90%; box-shadow:0 24px 64px rgba(0,0,0,.6); }
        .tb-login-box h2 { color:#fff; font-size:22px; font-weight:800; margin-bottom:8px; letter-spacing:-0.5px; }
        .tb-login-box p { color:#6e7d8c; font-size:13px; line-height:1.6; margin-bottom:20px; }
        .tb-login-box input { width:100%; background:#1e252c; border:1px solid rgba(204,218,231,0.08); border-radius:10px; color:#fff; font-family:inherit; font-size:14px; padding:14px 16px; outline:none; transition:border-color .2s, box-shadow .2s; }
        .tb-login-box input:focus { border-color:#3aecba; box-shadow:0 0 0 4px rgba(58,236,186,0.10); }
        .tb-login-box button { margin-top:14px; width:100%; padding:13px; border:none; border-radius:10px; background:linear-gradient(135deg,#3aecba 0%,#524add 100%); color:#0d1117; font-family:inherit; font-size:14px; font-weight:700; cursor:pointer; transition:all .15s; }
        .tb-login-box button:hover { box-shadow:0 8px 24px rgba(58,236,186,0.25); transform:translateY(-1px); }
      </style>
      <div class="tb-login-box">
        <h2>Enter your access token</h2>
        <p>You're viewing the public board, but you need a token to make changes (add, edit, delete). Your token is stored locally in this browser.</p>
        <input id="tb-token-input" type="password" placeholder="paste your token here…" autocomplete="off">
        <button id="tb-token-submit">Continue</button>
      </div>
    `;
    document.body.appendChild(ov);
    const input = document.getElementById('tb-token-input');
    input.focus();
    const submit = () => {
      const v = input.value.trim();
      if (!v) return;
      setToken(v);
      ov.remove();
    };
    document.getElementById('tb-token-submit').addEventListener('click', submit);
    input.addEventListener('keydown', e => { if (e.key === 'Enter') submit(); });
  }

  // Expose globally
  window.TBApi = {
    base: API_BASE,
    isLocal,
    fetch: tbFetch,
    getToken,
    setToken,
    showLoginOverlay,
  };
})();
