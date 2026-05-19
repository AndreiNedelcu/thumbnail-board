#!/usr/bin/env python3
"""
server.py — Local server para Thumbnail Board con integración Eagle en tiempo real

Sirve la web en http://localhost:3000 y actúa como proxy de Eagle API,
eliminando los problemas de CORS/Mixed Content.

También sincroniza automáticamente con Eagle: detecta cambios cada 30 segundos.

Uso:
    python3 server.py
"""

import json, re, time, threading, os, sys, subprocess
from pathlib import Path
from http.server import HTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs
from urllib.request import urlopen, Request
from urllib.error import URLError

EAGLE_API  = "http://localhost:41595"
FOLDER_ID  = "MPBRJ4DRT0IR0"
PORT       = 3000
DATA_FILE  = Path(__file__).parent / "data.json"
SYNC_EVERY = 30  # seconds

VALID_PREFIXES = {"style","mood","text","element","camera","subject","formation","topic","callout","backdrop"}
TYPO_MAP = {
    "mood-suprised":"mood-surprised","mood-surpised":"mood-surprised",
    "background-blurry":"backdrop-blurry","backround-blurry":"backdrop-blurry",
    "dark-backdrop":"backdrop-dark","backdrop-black":"backdrop-dark",
    "backdrop-ligh":"backdrop-light","backdrop-blur":"backdrop-blurry",
    "stle-photoshopped":"style-photoshopped","style-collate":"style-collage",
    "style-identity":"text-identity","style-minmal":"style-minimal",
    "style-rd":None,"style-split-view":"style-split-screen",
    "style-handdranw":"style-handdrawn","formation-overhead-shot":None,
    "mode-entertaining":"mood-entertaining","mode-happy":"mood-happy",
    "callout-text":None,"element-eyes":"element-eye",
    "text-numbber":"text-number","text-forwad-referencing":"text-forward-referencing",
    "subject-behidn-object":None,"subject-count-one":None,
    "mood-disgusted":None,"callout":None,"contrst":None,
}
YT_RE = re.compile(r"(?:watch\?v=|youtu\.be/)([A-Za-z0-9_-]{11})")

# ── Eagle helpers ────────────────────────────────────────────────

def eagle_get(path, params=""):
    url = f"{EAGLE_API}{path}{'?' + params if params else ''}"
    try:
        req = Request(url, headers={"User-Agent": "Mozilla/5.0"})
        with urlopen(req, timeout=8) as r:
            return json.loads(r.read())
    except Exception as e:
        return {"error": str(e)}

def eagle_post(path, body):
    url = f"{EAGLE_API}{path}"
    data = json.dumps(body).encode()
    try:
        req = Request(url, data=data, headers={"Content-Type":"application/json","User-Agent":"Mozilla/5.0"})
        with urlopen(req, timeout=8) as r:
            return json.loads(r.read())
    except Exception as e:
        return {"error": str(e)}

def mcp_call(method, params):
    try:
        req = Request(
            f"{EAGLE_MCP}/mcp",
            data=json.dumps({"jsonrpc":"2.0","id":1,"method":method,"params":params}).encode(),
            headers={"Content-Type":"application/json","Accept":"application/json, text/event-stream","User-Agent":"Mozilla/5.0"}
        )
        with urlopen(req, timeout=30) as r:
            text = r.read().decode()
        parts, collecting = [], False
        for line in text.splitlines():
            if line.startswith("data:"):
                parts = [line[5:]]; collecting = True
            elif collecting and line == "": break
            elif collecting: parts.append(line)
        d = json.loads("".join(parts))
        if "result" in d: return d["result"]
        raise Exception(d.get("error",{}).get("message","MCP error"))
    except Exception as e:
        raise Exception(f"MCP: {e}")

def get_all_eagle_items():
    seen, items = set(), []

    # MCP — gets all 2000+ items with filePaths
    offset, limit = 0, 200
    while True:
        try:
            result = mcp_call("tools/call", {
                "name": "item_get",
                "arguments": {"folders": [FOLDER_ID], "limit": limit, "offset": offset, "fullDetails": False}
            })
            text = result.get("content",[{}])[0].get("text","")
            batch = json.loads(text).get("data", [])
        except Exception as e:
            print(f"  MCP stopped at offset {offset}: {e}", flush=True)
            break
        for b in batch:
            if b["id"] not in seen:
                seen.add(b["id"])
                fp = b.get("filePath","")
                if fp:
                    mp = Path(fp).parent / "metadata.json"
                    try: items.append(json.loads(mp.read_text())); continue
                    except: pass
                items.append(b)
        if len(batch) < limit: break
        offset += limit

    # REST fallback for any missed items
    for order in ["CREATEDATE","NAME","FILESIZE","MODIFYDATE"]:
        offset = 0
        while True:
            data = eagle_get("/api/item/list",
                f"folders[]={FOLDER_ID}&limit=200&offset={offset}&orderBy={order}")
            batch = data.get("data", [])
            if not batch: break
            for b in batch:
                if b["id"] not in seen:
                    seen.add(b["id"])
                    items.append(b)
            if len(batch) < 200: break
            offset += 200

    print(f"  Eagle items: {len(items)}", flush=True)
    return items

def canonicalize_tags(raw):
    result, seen = [], set()
    for t in raw:
        c = TYPO_MAP.get(t, t)
        if not c: continue
        p = c.split("-")[0] if "-" in c else ""
        if p not in VALID_PREFIXES: continue
        if c not in seen: result.append(c); seen.add(c)
    return result

def extract_vid_id(item):
    for f in ["url","annotation"]:
        m = YT_RE.search(item.get(f,"") or "")
        if m: return m.group(1)
    return None

def sync_with_eagle(eagle_items, dataset):
    """
    Sync dataset with Eagle items:
    - Items already in dataset with an eid: update tags from Eagle if changed
    - Items in Eagle with a YouTube URL and tags but not in dataset: add them
    Returns (updated_dataset, n_updated, n_added)
    """
    # Build lookup maps
    by_vid_id = {v["id"]: v for v in dataset}
    by_eid    = {v["eid"]: v for v in dataset if v.get("eid")}

    n_updated, n_added = 0, 0
    seen_vids = set(by_vid_id.keys())

    for item in eagle_items:
        eagle_id = item.get("id", "")
        eagle_tags = canonicalize_tags(item.get("tags") or [])

        # ── Update existing entry by eid ──
        if eagle_id and eagle_id in by_eid:
            entry = by_eid[eagle_id]
            if eagle_tags and set(eagle_tags) != set(entry.get("tags", [])):
                entry["tags"] = eagle_tags
                n_updated += 1
            continue

        # ── Add new entry ──
        vid_id = extract_vid_id(item)
        if not vid_id or not eagle_tags: continue
        if vid_id in seen_vids: continue
        seen_vids.add(vid_id)
        dataset.append({"id": vid_id, "title": item.get("name",""), "channel":"", "views":"",
                         "tags": eagle_tags, "eid": eagle_id})
        n_added += 1

    return dataset, n_updated, n_added

# ── Auto-sync thread ──────────────────────────────────────────────

_dataset = []
_last_count = 0

def load_dataset():
    global _dataset
    if DATA_FILE.exists():
        _dataset = json.loads(DATA_FILE.read_text())

def force_sync():
    global _dataset, _last_count
    try:
        items = get_all_eagle_items()
        dataset, n_updated, n_added = sync_with_eagle(items, list(_dataset))
        _dataset = dataset
        _last_count = len(dataset)
        DATA_FILE.write_text(json.dumps(dataset, ensure_ascii=False, separators=(",",":")))
        print(f"[sync] Force sync: +{n_added} new, {n_updated} updated → {len(dataset)} total", flush=True)
    except Exception as e:
        print(f"[sync] Force sync error: {e}", flush=True)

def sync_loop():
    global _dataset, _last_count
    while True:
        try:
            items = get_all_eagle_items()
            new_items = build_new_from_eagle(items, existing_by_id)
            items = get_all_eagle_items()
            dataset, n_updated, n_added = sync_with_eagle(items, list(_dataset))
            if n_updated or n_added:
                _dataset = dataset
                _last_count = len(dataset)
                DATA_FILE.write_text(json.dumps(dataset, ensure_ascii=False, separators=(",",":")))
                print(f"[sync] +{n_added} new, {n_updated} updated → {len(dataset)} total", flush=True)
        except Exception as e:
            print(f"[sync] Error: {e}", flush=True)
        time.sleep(SYNC_EVERY)

# ── HTTP Handler ─────────────────────────────────────────────────

MIME = {".html":"text/html",".js":"application/javascript",
        ".css":"text/css",".json":"application/json",".py":"text/plain"}

class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        pass  # suppress default logs

    def send_json(self, data, status=200):
        body = json.dumps(data, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", len(body))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        parsed = urlparse(self.path)
        path   = parsed.path
        params = parse_qs(parsed.query)

        # ── API routes ──
        if path == "/api/data":
            self.send_json(_dataset)
            return

        if path == "/api/eagle/open":
            vid_id = params.get("videoId", [""])[0]
            # Find Eagle item ID by searching for the video ID
            data = eagle_get("/api/item/list", f"limit=5&keyword={vid_id}")
            item = (data.get("data") or [None])[0]
            if item:
                self.send_json({"ok": True, "eagle_id": item["id"], "name": item.get("name","")})
            else:
                self.send_json({"ok": False, "msg": "Not found in Eagle"})
            return

        if path == "/api/eagle/status":
            data = eagle_get("/api/application/info")
            self.send_json({"ok": "error" not in data, "count": len(_dataset)})
            return

        if path == "/api/eagle/items":
            folder = params.get("folder", [FOLDER_ID])[0]
            order  = params.get("order", ["CREATEDATE"])[0]
            offset = params.get("offset", ["0"])[0]
            data = eagle_get("/api/item/list",
                f"folders[]={folder}&limit=200&offset={offset}&orderBy={order}")
            self.send_json(data)
            return

        if path == "/api/eagle/all-items":
            # Return ALL items from folder using MCP+REST (for tagger)
            all_items = get_all_eagle_items()
            self.send_json({"status":"success","data":all_items})
            return

        if path == "/api/sync":
            # Trigger immediate sync
            threading.Thread(target=force_sync, daemon=True).start()
            self.send_json({"ok": True, "msg": "Sync started"})
            return

        # ── Static files ──
        if path == "/" or path == "":
            path = "/index.html"

        file_path = Path(__file__).parent / path.lstrip("/")
        if file_path.exists() and file_path.is_file():
            ext  = file_path.suffix
            mime = MIME.get(ext, "application/octet-stream")
            body = file_path.read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", mime)
            self.send_header("Content-Length", len(body))
            self.end_headers()
            self.wfile.write(body)
        else:
            self.send_response(404)
            self.end_headers()

    def do_POST(self):
        parsed = urlparse(self.path)
        path   = parsed.path
        length = int(self.headers.get("Content-Length", 0))
        body   = json.loads(self.rfile.read(length)) if length else {}

        if path == "/api/eagle/update":
            # Proxy Eagle item update
            result = eagle_post("/api/item/update", body)
            self.send_json(result)
            return

        if path == "/api/delete":
            vid_id = body.get("id", "")
            if not vid_id:
                self.send_json({"ok": False, "msg": "No id provided"})
                return
            before = len(_dataset)
            new_dataset = [v for v in _dataset if v.get("id") != vid_id]
            if len(new_dataset) == before:
                self.send_json({"ok": False, "msg": "Video not found"})
                return
            global _dataset
            _dataset = new_dataset
            DATA_FILE.write_text(json.dumps(_dataset, ensure_ascii=False, separators=(",",":")))
            print(f"[delete] Removed {vid_id} → {len(_dataset)} total", flush=True)
            self.send_json({"ok": True, "msg": f"Deleted {vid_id}"})
            return

        if path == "/api/publish":
            # Commit + push data.json to GitHub
            try:
                repo = Path(__file__).parent
                count = len(_dataset)
                subprocess.run(["git", "add", "data.json"], cwd=repo, check=True)
                # Check if there's anything to commit
                diff = subprocess.run(["git", "diff", "--cached", "--stat"], cwd=repo, capture_output=True, text=True)
                if not diff.stdout.strip():
                    self.send_json({"ok": True, "msg": "Already up to date — nothing new to publish"})
                    return
                msg = f"data: sync {count} thumbnails from Eagle"
                subprocess.run(["git", "commit", "-m", msg], cwd=repo, check=True)
                subprocess.run(["git", "push"], cwd=repo, check=True)
                print(f"[publish] Pushed data.json ({count} items)", flush=True)
                self.send_json({"ok": True, "msg": f"{count} thumbnails published to GitHub"})
            except subprocess.CalledProcessError as e:
                self.send_json({"ok": False, "msg": str(e)})
            return

        self.send_response(404)
        self.end_headers()

    def do_OPTIONS(self):
        self.send_response(200)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

# ── Main ─────────────────────────────────────────────────────────

def main():
    load_dataset()

    # Start sync thread
    t = threading.Thread(target=sync_loop, daemon=True)
    t.start()

    print(f"\n{'='*50}")
    print(f"  Thumbnail Board — Local Server")
    print(f"{'='*50}")
    print(f"\n  🌐 http://localhost:{PORT}")
    print(f"  🦅 Eagle sync every {SYNC_EVERY}s")
    print(f"  📦 {len(_dataset)} thumbnails loaded")
    print(f"\n  Press Ctrl+C to stop\n")

    server = HTTPServer(("localhost", PORT), Handler)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n  Stopped.")

if __name__ == "__main__":
    main()
