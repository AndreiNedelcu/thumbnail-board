#!/usr/bin/env python3
"""
review.py — review pending_review.json from auto_tag.py and push approved
items to the cloud board.

Opens a local web page (review.html) that lets you go through each AI-tagged
item, edit the tags, then approve or reject. Approved items are POSTed
to the Worker. Rejected ones get moved to a "rejected" pile.

Usage:
  python3 review.py            # opens browser at http://localhost:8765
  python3 review.py --port 9000
"""
import argparse, json, http.server, os, socketserver, sys, threading, urllib.request, webbrowser
from pathlib import Path

ROOT = Path(__file__).parent
REVIEW_FILE   = ROOT / "pending_review.json"
REJECTED_FILE = ROOT / "pending_rejected.json"

WORKER_URL = "https://thumbnail-board-api.andrei-nndd.workers.dev"
AUTH_TOKEN = os.environ.get("TB_AUTH_TOKEN") or ""
if not AUTH_TOKEN:
    print("⚠ Set TB_AUTH_TOKEN env var with your AUTH_TOKEN. e.g.:")
    print("   export TB_AUTH_TOKEN='91q9YY3Eqgp5xwbA9dlGZWeGjYOLr6FQXDRdSqpr1eo='")
    print("   python3 review.py")
    sys.exit(1)

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
        if self.path == "/api/review-items":
            items = json.loads(REVIEW_FILE.read_text()) if REVIEW_FILE.exists() else []
            return self._json(items)
        return super().do_GET()

    def do_POST(self):
        n = int(self.headers.get("Content-Length", "0"))
        body = json.loads(self.rfile.read(n) or b"{}")
        if self.path == "/api/approve":
            return self._handle_approve(body)
        if self.path == "/api/reject":
            return self._handle_reject(body)
        return self._json({"ok": False, "msg": "Not found"}, 404)

    def _handle_approve(self, entry):
        # POST to worker /api/add
        payload = json.dumps(entry).encode()
        req = urllib.request.Request(
            f"{WORKER_URL}/api/add",
            data=payload,
            headers={"Content-Type": "application/json", "X-Auth-Token": AUTH_TOKEN},
        )
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                resp = json.loads(r.read())
        except Exception as e:
            return self._json({"ok": False, "msg": str(e)}, 500)
        if not resp.get("ok"):
            return self._json(resp, 400)
        # Remove from pending_review.json
        review = json.loads(REVIEW_FILE.read_text())
        review = [r for r in review if r["id"] != entry["id"]]
        REVIEW_FILE.write_text(json.dumps(review, ensure_ascii=False, indent=2))
        return self._json({"ok": True})

    def _handle_reject(self, entry):
        rejected = json.loads(REJECTED_FILE.read_text()) if REJECTED_FILE.exists() else []
        rejected.append(entry)
        REJECTED_FILE.write_text(json.dumps(rejected, ensure_ascii=False, indent=2))
        review = json.loads(REVIEW_FILE.read_text())
        review = [r for r in review if r["id"] != entry["id"]]
        REVIEW_FILE.write_text(json.dumps(review, ensure_ascii=False, indent=2))
        return self._json({"ok": True})

    def log_message(self, *a, **k): pass

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8765)
    args = ap.parse_args()

    with socketserver.TCPServer(("", args.port), Handler) as httpd:
        url = f"http://localhost:{args.port}/review.html"
        print(f"📋 Review server: {url}")
        threading.Timer(0.5, lambda: webbrowser.open(url)).start()
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nbye")

if __name__ == "__main__":
    main()
