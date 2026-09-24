"""Vercel function: GET /api/crew?id=<Space id>. Thin: the answer comes from RadioService."""
import os
import sys
from http.server import BaseHTTPRequestHandler
from urllib.parse import urlparse

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from spaces_radio.service import shared_service, write_reply  # noqa: E402


class handler(BaseHTTPRequestHandler):
    def do_GET(self):
        # The raw query: the CDN keys on it, so only one spelling per room is served.
        write_reply(self, shared_service().crew_raw(urlparse(self.path).query))
