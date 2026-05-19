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
FEEDBACK_FILE = ROOT / "auto_tag_feedback.json"  # learning signal for next batch

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

    def _record_feedback(self, entry, outcome):
        """Append a teaching example so the next auto_tag batch learns from it."""
        fb = json.loads(FEEDBACK_FILE.read_text()) if FEEDBACK_FILE.exists() else []
        fb.append({
            "id": entry.get("id"),
            "title": entry.get("title", ""),
            "ai_tags": entry.get("ai_tags") or [],
            "final_tags": entry.get("tags") or [],
            "outcome": outcome,         # "approved" or "rejected"
            "ts": int(__import__("time").time()),
        })
        FEEDBACK_FILE.write_text(json.dumps(fb, ensure_ascii=False, indent=2))

    def _handle_approve(self, entry):
        payload = json.dumps(entry).encode()
        req = urllib.request.Request(
            f"{WORKER_URL}/api/add",
            data=payload,
            headers={
                "Content-Type": "application/json",
                "X-Auth-Token": AUTH_TOKEN,
                "User-Agent": "ThumbnailBoardReview/1.0 (review.py)",
            },
        )
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                resp = json.loads(r.read())
        except urllib.error.HTTPError as e:
            # Worker returned 4xx/5xx — read body for the actual message
            body = e.read().decode("utf-8", "replace")
            print(f"[approve] Worker HTTP {e.code} for {entry.get('id')}: {body}", file=sys.stderr)
            try:
                worker_resp = json.loads(body)
                return self._json(worker_resp, e.code)
            except Exception:
                return self._json({"ok": False, "msg": f"HTTP {e.code}: {body[:200]}"}, e.code)
        except Exception as e:
            print(f"[approve] network error for {entry.get('id')}: {e}", file=sys.stderr)
            return self._json({"ok": False, "msg": str(e)}, 500)
        print(f"[approve] worker response for {entry.get('id')}: {resp}", file=sys.stderr)
        if not resp.get("ok"):
            return self._json(resp, 400)
        # Record what AI said vs what user kept — feedback for next batch
        self._record_feedback(entry, "approved")
        # Remove from pending_review.json
        review = json.loads(REVIEW_FILE.read_text())
        review = [r for r in review if r["id"] != entry["id"]]
        REVIEW_FILE.write_text(json.dumps(review, ensure_ascii=False, indent=2))
        return self._json({"ok": True})

    def _handle_reject(self, entry):
        rejected = json.loads(REJECTED_FILE.read_text()) if REJECTED_FILE.exists() else []
        rejected.append(entry)
        REJECTED_FILE.write_text(json.dumps(rejected, ensure_ascii=False, indent=2))
        # Record as feedback too — telling AI "these tags weren't good enough"
        self._record_feedback(entry, "rejected")
        review = json.loads(REVIEW_FILE.read_text())
        review = [r for r in review if r["id"] != entry["id"]]
        REVIEW_FILE.write_text(json.dumps(review, ensure_ascii=False, indent=2))
        return self._json({"ok": True})

    def log_message(self, format, *args):
        # Keep noise low but show errors and POST requests
        msg = format % args if args else format
        if " 4" in msg or " 5" in msg or "POST" in msg:
            print(f"[review.py] {msg}", file=sys.stderr)

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8765)
    args = ap.parse_args()

    class ReusableServer(socketserver.TCPServer):
        allow_reuse_address = True
    with ReusableServer(("", args.port), Handler) as httpd:
        url = f"http://localhost:{args.port}/review.html"
        print(f"📋 Review server: {url}")
        threading.Timer(0.5, lambda: webbrowser.open(url)).start()
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nbye")

if __name__ == "__main__":
    main()
