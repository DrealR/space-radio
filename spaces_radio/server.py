"""Space Radio, local dev server. Same answers as the Vercel functions.

    python3 -m spaces_radio.server            # no key: people paste rooms they find
    python3 ~/Morrow/tools/mo_keys.py run --project spaces-radio -- python3 -m spaces_radio.server
                                              # + live search via X_BEARER_TOKEN (paid)

Listens on 127.0.0.1 only.
"""
from __future__ import annotations

import os
import sys
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from .service import Reply, RadioService, envelope, service_from_env, write_reply

PUBLIC = Path(__file__).resolve().parent.parent / "public"
PORT = int(os.environ.get("SPACES_RADIO_PORT", "8740"))
TYPES = {".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript", ".mjs": "text/javascript",
         ".svg": "image/svg+xml", ".png": "image/png", ".webmanifest": "application/manifest+json"}


def make_handler(service: RadioService):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, fmt, *args):
            if self.path.startswith("/api/"):
                sys.stderr.write("[spaces-radio] " + fmt % args + "\n")

        def do_GET(self):
            url = urlparse(self.path)
            if url.path == "/api/status":
                return write_reply(self, service.status())
            if url.path == "/api/tune":
                return write_reply(self, service.tune(parse_qs(url.query, keep_blank_values=True)))
            self._static(url.path)

        def _static(self, url_path: str):
            path = (PUBLIC / (url_path.lstrip("/") or "index.html")).resolve()
            if PUBLIC not in path.parents or not path.is_file():
                return write_reply(self, Reply(404, envelope(error="Not found.")))
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", TYPES.get(path.suffix, "application/octet-stream"))
            self.end_headers()
            self.wfile.write(path.read_bytes())

    return Handler


def main() -> None:
    service = service_from_env()
    server = ThreadingHTTPServer(("127.0.0.1", PORT), make_handler(service))
    mode = "live search on" if service.live_search else "no X key: pasted rooms only"
    print(f"Space Radio · http://127.0.0.1:{PORT} · {mode}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nRadio off.")


if __name__ == "__main__":
    main()
