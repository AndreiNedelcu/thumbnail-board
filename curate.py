#!/usr/bin/env python3
"""
curate.py — local UI to pick which YouTube candidates to keep.

Reads youtube_candidates.json (built by scrape_youtube.py), shows a
grid in the browser, lets you click thumbnails to keep/reject. Kept
candidates get appended to eagle-pending.json so auto_tag.py picks
them up.

Usage:
  python3 curate.py            # opens http://localhost:8766/curate.html
  python3 curate.py --port 9001
"""
import argparse, http.server, json, socketserver, sys, threading, webbrowser
from pathlib import Path

ROOT = Path(__file__).parent
CANDIDATES_FILE = ROOT / "youtube_candidates.json"
PENDING_FILE    = ROOT / "eagle-pending.json"
DISCARDED_FILE  = ROOT / "youtube_discarded.json"

class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=str(ROOT), **kw)

    def _json(self, obj, status=200):
        body = json.dumps(obj).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/api/candidates":
            items = json.loads(CANDIDATES_FILE.read_text()) if CANDIDATES_FILE.exists() else []
            return self._json(items)
        return super().do_GET()

    def do_POST(self):
        n = int(self.headers.get("Content-Length", "0"))
        body = json.loads(self.rfile.read(n) or b"{}")
        if self.path == "/api/commit":
            return self._commit(body)
        return self._json({"ok": False}, 404)

    def _commit(self, body):
        kept_ids = set(body.get("kept", []))
        rejected_ids = set(body.get("rejected", []))
        candidates = json.loads(CANDIDATES_FILE.read_text()) if CANDIDATES_FILE.exists() else []

        # Build kept list with their data
        kept_items = [c for c in candidates if c["id"] in kept_ids]
        rejected_items = [c for c in candidates if c["id"] in rejected_ids]

        # Append kept to eagle-pending.json (de-duped)
        pending = json.loads(PENDING_FILE.read_text()) if PENDING_FILE.exists() else []
        existing = {p["id"] for p in pending}
        added = 0
        for k in kept_items:
            if k["id"] in existing: continue
            pending.append({
                "id": k["id"], "eid": "",
                "title": k.get("title",""),
                "channel": k.get("channel",""),
                "views": k.get("views",""),
                "tags": [],
            })
            added += 1
        PENDING_FILE.write_text(json.dumps(pending, ensure_ascii=False, indent=2))

        # Save rejected for the record
        discarded = json.loads(DISCARDED_FILE.read_text()) if DISCARDED_FILE.exists() else []
        discarded.extend(rejected_items)
        DISCARDED_FILE.write_text(json.dumps(discarded, ensure_ascii=False, indent=2))

        # Keep only undecided in candidates file
        leftover = [c for c in candidates if c["id"] not in kept_ids and c["id"] not in rejected_ids]
        CANDIDATES_FILE.write_text(json.dumps(leftover, ensure_ascii=False, indent=2))

        return self._json({"ok": True, "kept": len(kept_items), "added_to_pending": added,
                           "rejected": len(rejected_items), "leftover": len(leftover)})

    def log_message(self, format, *args):
        msg = format % args if args else format
        if " 4" in msg or " 5" in msg or "POST" in msg:
            print(f"[curate.py] {msg}", file=sys.stderr)

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8766)
    args = ap.parse_args()

    class ReusableServer(socketserver.TCPServer):
        allow_reuse_address = True

    with ReusableServer(("", args.port), Handler) as httpd:
        url = f"http://localhost:{args.port}/curate.html"
        print(f"🖼  Curation grid: {url}")
        threading.Timer(0.5, lambda: webbrowser.open(url)).start()
        try: httpd.serve_forever()
        except KeyboardInterrupt: print("\nbye")

if __name__ == "__main__":
    main()
