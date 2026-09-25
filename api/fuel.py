"""Vercel function: GET /api/fuel: today's estimated X spend. Thin: the answer comes from RadioService."""
import os
import sys
from http.server import BaseHTTPRequestHandler

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from spaces_radio.service import shared_service, write_reply  # noqa: E402


class handler(BaseHTTPRequestHandler):
    def do_GET(self):
        write_reply(self, shared_service().fuel())
