"""Docking: two radios linked through a tunnel, the xenonite wall from Project Hail Mary.

Each ship keeps its own body (its own X account, its own dial) and writes only its
own slot: dock-<token>-a (the ship that opened the port) or dock-<token>-b (the ship
that came through the link). Every beat writes your slot and reads your partner's.
Nothing here touches X, and nothing outlives the dock: slots expire when ships go quiet.

A slot belongs to the ship that holds it while that ship keeps beating, so a third
radio holding the same link finds the dock full instead of taking someone's place.
"""
from __future__ import annotations

import json
import re
import threading
import time
from dataclasses import dataclass
from typing import Callable, Optional, Protocol

TOKEN = re.compile(r"[A-Z]{3,6}-\d{2}\.[0-9a-f]{12}")   # ERID-42.3f9a0c1b2d4e
SHIP = re.compile(r"[0-9a-f]{16}")                      # one browser tab's ship id
SPACE_ID = re.compile(r"[A-Za-z0-9]{8,20}")
TONES = frozenset({"fist", "amaze", "come", "onward"})
ROLES = {"a": "b", "b": "a"}
MAX_BODY = 2048
IDLE_SECONDS = 30 * 60     # a slot nobody beats for 30 minutes is gone
CLAIM_SECONDS = 45         # a ship that stopped beating this long ago gives up its slot
_UNSAFE = re.compile(r"[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]")


class DockStore(Protocol):
    def get(self, key: str) -> object | None: ...
    def set(self, key: str, value: object, options: dict | None = None) -> None: ...


class MemoryStore:
    """Local and test store with the same get/set shape as Vercel's Runtime Cache."""

    def __init__(self, now: Callable[[], float] = time.time):
        self._items: dict = {}
        self._lock = threading.Lock()
        self._now = now

    def get(self, key: str):
        with self._lock:
            hit = self._items.get(key)
            if not hit or hit[0] < self._now():
                return None
            return json.loads(hit[1])

    def set(self, key: str, value, options: dict | None = None) -> None:
        ttl = (options or {}).get("ttl", IDLE_SECONDS)
        with self._lock:
            self._items = {**self._items, key: (self._now() + ttl, json.dumps(value))}


@dataclass(frozen=True)
class Beat:
    token: str
    role: str
    ship: str
    state: dict


class DockError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status


def _clean_text(value, limit: int) -> str:
    return _UNSAFE.sub("", str(value or "")).strip()[:limit]


def _room(raw) -> Optional[dict]:
    if not isinstance(raw, dict) or not SPACE_ID.fullmatch(str(raw.get("id", ""))):
        return None
    listeners = raw.get("listeners")
    return {"id": raw["id"], "title": _clean_text(raw.get("title"), 120) or "Untitled room",
            "listeners": listeners if isinstance(listeners, int) and 0 <= listeners < 10**7 else None}


def clean_state(raw) -> dict:
    """What a ship may say about itself: its room, band, whether it's on air, its last tone."""
    raw = raw if isinstance(raw, dict) else {}
    tone = raw.get("tone") if isinstance(raw.get("tone"), dict) else {}
    seq = tone.get("seq")
    clean_tone = None
    if tone.get("kind") in TONES and isinstance(seq, int) and 0 < seq < 10**9:
        clean_tone = {"kind": tone["kind"], "seq": seq, "room": _room(tone.get("room"))}
    return {"room": _room(raw.get("room")), "band": _clean_text(raw.get("band"), 24),
            "air": raw.get("air") is True, "tone": clean_tone, "left": raw.get("left") is True}


def parse_beat(body: bytes) -> Beat:
    if not body or len(body) > MAX_BODY:
        raise DockError(400, "Send a small JSON beat.")
    try:
        raw = json.loads(body)
    except ValueError:
        raise DockError(400, "The beat isn't valid JSON.")
    if not isinstance(raw, dict):
        raise DockError(400, "The beat must be a JSON object.")
    token, role, ship = raw.get("token"), raw.get("role"), raw.get("ship")
    if not isinstance(token, str) or not TOKEN.fullmatch(token):
        raise DockError(400, "That isn't a dock code.")
    if role not in ROLES or not isinstance(ship, str) or not SHIP.fullmatch(ship):
        raise DockError(400, "Unknown ship.")
    return Beat(token, role, ship, clean_state(raw.get("state")))


def _slot(token: str, role: str) -> str:
    return f"dock-{token.replace('.', '-')}-{role}"   # url-safe: the key rides in the cache URL


def beat(store: DockStore, b: Beat, now: float) -> dict:
    """Write this ship's slot, read the partner's. Raises DockError(409) if the slot is someone else's."""
    held = store.get(_slot(b.token, b.role))
    if isinstance(held, dict) and held.get("ship") != b.ship:
        still_there = now - float(held.get("at", 0)) < CLAIM_SECONDS
        if still_there and not (held.get("state") or {}).get("left"):
            raise DockError(409, "This dock already has two ships.")
    store.set(_slot(b.token, b.role), {"ship": b.ship, "at": now, "state": b.state},
              {"ttl": IDLE_SECONDS, "name": "space-radio-dock"})
    peer = store.get(_slot(b.token, ROLES[b.role]))
    if not isinstance(peer, dict):
        return {"role": b.role, "peer": None}
    return {"role": b.role, "peer": {"state": clean_state(peer.get("state")),
                                     "age": max(0.0, round(now - float(peer.get("at", now)), 1))}}
