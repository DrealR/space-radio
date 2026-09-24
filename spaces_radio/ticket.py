"""Tickets: proof that a room came from this radio's own search.

A full crew lookup names everyone aboard, and every name costs money. /api/crew
answers any well-formed id, so without a ticket anyone could make the radio pay
for rooms it never showed. /api/tune hands each room a ticket; /api/crew pays for
the whole crew only when the ticket matches, and names just the host otherwise
(presets, pasted in a browser, have no ticket and get the host).

Tune and crew are separate functions with no shared memory, so a ticket is an
HMAC of the room id and a half-hour window: the same for every listener (one CDN
key per room), impossible to mint without the key, and good for the current and
the previous window, which outlasts the CDN and the page's 10-minute refresh.
"""
from __future__ import annotations

import hashlib
import hmac
import re
import time
from typing import Callable, Optional

TICKET_SECONDS = 1800
TICKET = re.compile(r"[0-9a-f]{16}")


class Tickets:
    def __init__(self, key: bytes, now: Callable[[], float] = time.time):
        if not key:
            raise ValueError("Tickets need a key")
        self._key = key
        self._now = now

    def issue(self, space_id: str) -> str:
        return self._sign(space_id, self._window())

    def valid(self, space_id: str, ticket) -> bool:
        if not isinstance(ticket, str) or not TICKET.fullmatch(ticket):
            return False
        window = self._window()
        return any(hmac.compare_digest(ticket, self._sign(space_id, w)) for w in (window, window - 1))

    def _window(self) -> int:
        return int(self._now() // TICKET_SECONDS)

    def _sign(self, space_id: str, window: int) -> str:
        return hmac.new(self._key, f"{space_id}:{window}".encode(), hashlib.sha256).hexdigest()[:16]


def ticket_key(env, token: str) -> Optional[bytes]:
    """SPACES_RADIO_TICKET_KEY if set; else derived from the X key, so the tune and crew
    functions agree with no extra setting. The X key itself never leaves the server."""
    explicit = (env.get("SPACES_RADIO_TICKET_KEY") or "").strip()
    if explicit:
        return explicit.encode()
    if not token:
        return None
    return hmac.new(token.encode(), b"space-radio/ticket/v1", hashlib.sha256).digest()
