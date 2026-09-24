"""Vercel function: GET /api/tune. Thin: the answer comes from RadioService."""
import os
import sys
from http.server import BaseHTTPRequestHandler
from urllib.parse import parse_qs, urlparse

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from spaces_radio.service import shared_service, write_reply  # noqa: E402


class handler(BaseHTTPRequestHandler):
    def do_GET(self):
        query = parse_qs(urlparse(self.path).query, keep_blank_values=True)
        write_reply(self, shared_service().tune(query))
