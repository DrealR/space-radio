"""Spaces Radio: a local dial for live X Spaces.

    python3 -m spaces_radio.server            # saved rooms only, free
    python3 ~/Morrow/tools/mo_keys.py run --project spaces-radio -- python3 -m spaces_radio.server
                                              # + live search via X_BEARER_TOKEN (paid, capped)

Listens on 127.0.0.1 only. Every reply is {success, data, error, meta}.
"""
from __future__ import annotations

import json
import os
import sys
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from .budget import DEFAULT_DAILY_CAP, Budget
from .sources import SavedSource, SourceError, XApiSource
from .stations import STATIONS, tune

ROOT = Path(__file__).resolve().parent.parent
WEB = ROOT / "web"
DATA = Path(os.environ.get("SPACES_RADIO_DATA", ROOT / "data"))
PORT = int(os.environ.get("SPACES_RADIO_PORT", "8740"))
MAX_BODY = 4096
STATIC = {"/": "index.html", "/radio.css": "radio.css", "/radio.js": "radio.js"}
TYPES = {".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript"}


class Radio:
    """Owns the sources; the HTTP handler only translates requests."""

    def __init__(self, data_dir: Path, token: str = "", daily_cap: float = DEFAULT_DAILY_CAP):
        self.saved = SavedSource(data_dir / "saved-rooms.json")
        self.budget = Budget(data_dir / "x-budget.json", daily_cap)
        self.live_source = XApiSource(token, self.budget) if token else None

    def sources(self):
        return [s for s in (self.live_source, self.saved) if s]

    def status(self) -> dict:
        return {"live_search": bool(self.live_source), "stations": list(STATIONS),
                "budget": self.budget.status()}


def _reply(handler, status: int, data=None, error: str | None = None, meta: dict | None = None):
    body = json.dumps({"success": error is None, "data": data, "error": error, "meta": meta or {}})
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json")
    handler.send_header("Cache-Control", "no-store")
    handler.end_headers()
    handler.wfile.write(body.encode("utf-8"))


def make_handler(radio: Radio):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, fmt, *args):  # quieter console
            if not self.path.startswith("/api/"):
                return
            sys.stderr.write("[spaces-radio] " + fmt % args + "\n")

        def do_GET(self):
            url = urlparse(self.path)
            if url.path in STATIC:
                return self._static(STATIC[url.path])
            if url.path == "/api/status":
                return _reply(self, 200, radio.status())
            if url.path == "/api/tune":
                station = (parse_qs(url.query).get("station") or ["anything"])[0]
                if station not in STATIONS:
                    return _reply(self, 400, error=f"Unknown station '{station[:40]}'.")
                try:
                    rooms, problems = tune(station, radio.sources())
                except SourceError as err:
                    return _reply(self, 502, error=str(err))
                return _reply(self, 200, [r.to_json() for r in rooms],
                              meta={"station": station, "problems": problems,
                                    "budget": radio.budget.status()})
            if url.path == "/api/saved":
                return self._saved_list()
            return _reply(self, 404, error="Not found.")

        def do_POST(self):
            if urlparse(self.path).path != "/api/saved":
                return _reply(self, 404, error="Not found.")
            body = self._json_body()
            if body is None:
                return
            try:
                room = radio.saved.add(str(body.get("link", "")), str(body.get("title", "")),
                                       str(body.get("topic", "")))
            except ValueError as err:
                return _reply(self, 400, error=str(err))
            _reply(self, 201, room.to_json())

        def do_DELETE(self):
            path = urlparse(self.path).path
            if not path.startswith("/api/saved/"):
                return _reply(self, 404, error="Not found.")
            removed = radio.saved.remove(path.rsplit("/", 1)[-1])
            _reply(self, 200 if removed else 404, {"removed": removed},
                   None if removed else "No saved room with that id.")

        def _saved_list(self):
            try:
                _reply(self, 200, [r.to_json() for r in radio.saved.all()])
            except SourceError as err:
                _reply(self, 500, error=str(err))

        def _json_body(self):
            length = int(self.headers.get("Content-Length") or 0)
            if length <= 0 or length > MAX_BODY:
                _reply(self, 400, error="Send a small JSON body.")
                return None
            try:
                body = json.loads(self.rfile.read(length))
            except ValueError:
                _reply(self, 400, error="Body isn't valid JSON.")
                return None
            if not isinstance(body, dict):
                _reply(self, 400, error="Body must be a JSON object.")
                return None
            return body

        def _static(self, name: str):
            path = WEB / name
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", TYPES.get(path.suffix, "application/octet-stream"))
            self.end_headers()
            self.wfile.write(path.read_bytes())

    return Handler


def main() -> None:
    token = os.environ.get("X_BEARER_TOKEN", "").strip()
    cap = float(os.environ.get("SPACES_RADIO_DAILY_CAP", DEFAULT_DAILY_CAP))
    radio = Radio(DATA, token, cap)
    server = ThreadingHTTPServer(("127.0.0.1", PORT), make_handler(radio))
    mode = f"live search on, cap ${cap:.2f}/day" if token else "saved rooms only (no X key)"
    print(f"Spaces Radio · http://127.0.0.1:{PORT} · {mode}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nRadio off.")


if __name__ == "__main__":
    main()
