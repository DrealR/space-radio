"""Vercel function: POST /api/dock. One beat from a docked radio (see spaces_radio/dock.py)."""
import os
import sys
from http.server import BaseHTTPRequestHandler

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from spaces_radio.service import Reply, dock_post, envelope, write_reply  # noqa: E402

MAX_BODY = 4096


class handler(BaseHTTPRequestHandler):
    def do_POST(self):
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length) if 0 < length <= MAX_BODY else b""
        write_reply(self, dock_post(body))

    def do_GET(self):
        write_reply(self, Reply(405, envelope(error="Docking beats are POSTed.")))
