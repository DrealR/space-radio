"""What the radio answers, independent of who serves it.

The local dev server and the Vercel functions both call RadioService and
write its Reply; neither knows about X, budgets or caching rules.

Cost shape: one shared key, many listeners. Replies carry a CDN lifetime, so
everyone tuned to "music" in the same ten minutes gets the same cached answer
and X is asked once. X also bills each room once per UTC day, so spend follows
how many distinct rooms appear, not how many people listen. Crew lookups
(names) follow the same rule: one answer per room, shared for two minutes.

The CDN caches on the raw URL, so both entry points check the raw query string
(tune_raw, crew_raw): any other spelling of the same request is refused rather
than becoming a second, uncached key.
"""
from __future__ import annotations

import math
import os
import re
import sys
import traceback
from dataclasses import dataclass, field
from pathlib import Path
from urllib.parse import parse_qs, quote

from .budget import (DEFAULT_CREW_DAILY_CAP, DEFAULT_CREW_SPACE_CAP, DEFAULT_DAILY_CAP, PRICE_PER_SPACE,
                     PRICE_PER_USER, Budget)
from .crew import LIVE_SECONDS, MESSAGES, SETTLED_SECONDS, CrewError, CrewLookup, valid_crew_id
from .fixtures import make_fake_fetch
from .sources import SourceError, SpaceSource, XApiSource, _http_get_json
from .stations import STATIONS, tune
from .ticket import Tickets, ticket_key
from .words import word_from_raw

FRESH_SECONDS = 1800    # a good answer is shared for 30 minutes (each fresh search is billed)
TROUBLE_SECONDS = 60    # a partial or failed answer is retried sooner
STATUS_SECONDS = 300
ALLOWED_PARAMS = {"station"}
CREW_PARAMS = {"id", "t"}  # t: the ticket /api/tune gave the room (optional)
FAKE_CREW_DELAY = 0.8   # seconds; long enough to see SCANNING CREW locally
# Exactly what the page sends (encodeURIComponent), and nothing else: one CDN key per request.
TUNE_QUERIES = frozenset("station=" + quote(name, safe="") for name in STATIONS)  # late night -> late%20night
CREW_QUERY = re.compile(r"id=[A-Za-z0-9]{8,13}(?:&t=[0-9a-f]{16})?")
# /api/crew failures: reason -> (HTTP status, CDN seconds). Vercel's CDN doesn't cache 5xx answers,
# so these seconds reach browsers only; CrewLookup's hold is what keeps a busy X from being asked
# again at once. The same goes for TROUBLE_SECONDS on /api/tune errors.
CREW_ERRORS = {
    "bad-request": (400, 0), "bad-id": (400, 0),
    "no-key": (503, 300), "budget": (503, 60), "credits": (503, 60), "rate": (503, 30),
    "auth": (502, 60), "offline": (502, 30), "upstream": (502, 30),
}


@dataclass(frozen=True)
class Reply:
    status: int
    body: dict
    cdn_seconds: int = 0
    headers: dict = field(default_factory=dict)


def envelope(data=None, error: str | None = None, meta: dict | None = None) -> dict:
    return {"success": error is None, "data": data, "error": error, "meta": meta or {}}


class RadioService:
    def __init__(self, source: SpaceSource | None, budget: Budget, crew: CrewLookup | None = None,
                 tickets: Tickets | None = None):
        self._source = source
        self._budget = budget
        self._crew = crew
        self._tickets = tickets  # None: every crew request may name the whole crew

    @property
    def live_search(self) -> bool:
        return self._source is not None

    @property
    def crew_names(self) -> bool:
        return self._crew is not None

    def status(self) -> Reply:
        return Reply(200, envelope({"live_search": self.live_search, "stations": list(STATIONS)}),
                     STATUS_SECONDS)

    def tune_raw(self, raw_query: str) -> Reply:
        """GET /api/tune from the raw query string: other spellings would be separate CDN keys."""
        if raw_query not in TUNE_QUERIES:
            return Reply(400, envelope(error="Only ?station=<band> is accepted."))
        return self.tune(parse_qs(raw_query, keep_blank_values=True))

    def search_raw(self, raw_query: str) -> Reply:
        """GET /api/search?q=<word>: one word for a band someone made. Same sharing and cost
        rules as a built-in band's word: cached per word, X bills per room found."""
        word = word_from_raw(raw_query)
        if not word:
            return Reply(400, envelope(error="Search words are 2-30 letters, numbers, spaces, # $ or -."))
        if not self._source:
            return Reply(200, envelope([], meta={"word": word, "problems": []}), STATUS_SECONDS)
        try:
            rooms = [r.tagged("yours") for r in self._source.live(word)]
        except SourceError as err:
            return Reply(502, envelope(error=str(err), meta={"word": word}), TROUBLE_SECONDS)
        return Reply(200, envelope([self._ticketed(r.to_json()) for r in rooms],
                                   meta={"word": word, "problems": []}), FRESH_SECONDS)

    def crew_raw(self, raw_query: str) -> Reply:
        """GET /api/crew from the raw query string: exactly ?id=<id>, optionally &t=<ticket>."""
        if not CREW_QUERY.fullmatch(raw_query):
            return crew_error("bad-request")
        return self.crew(parse_qs(raw_query, keep_blank_values=True))

    def tune(self, query: dict) -> Reply:
        extra = set(query) - ALLOWED_PARAMS
        if extra:
            # Unknown params would split the shared cache and cost money; refuse them.
            return Reply(400, envelope(error="Only ?station= is accepted."))
        station = (query.get("station") or ["anything"])[0]
        if station not in STATIONS:
            return Reply(400, envelope(error=f"Unknown station '{station[:40]}'."))
        if not self._source:
            return Reply(200, envelope([], meta={"station": station, "problems": []}), STATUS_SECONDS)
        try:
            rooms, problems = tune(station, [self._source])
        except SourceError as err:
            return Reply(502, envelope(error=str(err)), TROUBLE_SECONDS)
        seconds = TROUBLE_SECONDS if problems else FRESH_SECONDS
        return Reply(200, envelope([self._ticketed(r.to_json()) for r in rooms],
                                   meta={"station": station, "problems": problems}), seconds)

    def _ticketed(self, room: dict) -> dict:
        return {**room, "ticket": self._tickets.issue(room["id"])} if self._tickets else room

    def crew(self, query: dict) -> Reply:
        """GET /api/crew?id=<bare Space id>: who is aboard. One paid lookup, shared by everyone."""
        ids, tickets = query.get("id"), query.get("t")
        if set(query) - CREW_PARAMS or any(v is not None and len(v) != 1 for v in (ids, tickets)):
            # Extra or repeated params would split the shared cache; each split costs money.
            return crew_error("bad-request")
        space_id = valid_crew_id(ids[0]) if ids else None
        if not space_id:
            return crew_error("bad-id")
        if not self._crew:
            return crew_error("no-key")
        # Only rooms this radio's own search returned get the whole (paid) crew; the rest, the host.
        trusted = self._tickets is None or self._tickets.valid(space_id, tickets[0] if tickets else "")
        try:
            scan, cached = self._crew.scan(space_id, trusted=trusted)
        except CrewError as err:
            return crew_error(err.reason)
        except Exception as err:  # a bug still answers in words, and leaves a trace without names
            _log_crash(space_id, err)
            return crew_error("upstream")
        seconds = LIVE_SECONDS if scan.state == "live" else SETTLED_SECONDS
        meta = {"fetched_at": scan.fetched_at, "mode": scan.mode, "cached": cached}
        return Reply(200, envelope(scan.to_json(), meta=meta), seconds)


def crew_error(reason: str) -> Reply:
    reason = reason if reason in CREW_ERRORS else "upstream"
    status, seconds = CREW_ERRORS[reason]
    return Reply(status, envelope(error=MESSAGES[reason], meta={"reason": reason}), seconds)


def _log_crash(space_id: str, err: Exception) -> None:
    frames = traceback.extract_tb(err.__traceback__)
    where = f"{Path(frames[-1].filename).name}:{frames[-1].lineno}" if frames else "?"
    sys.stderr.write(f"[spaces-radio] crew {space_id} crashed: {type(err).__name__} at {where}\n")


def service_from_env(env=os.environ) -> RadioService:
    """Token from X_BEARER_TOKEN. On Vercel only /tmp is writable, so the
    budgets there are per-instance soft guards; X's own spending limit is the hard cap.
    SPACES_RADIO_FAKE=1 swaps X for canned answers (local only, never on Vercel)."""
    fake = env.get("SPACES_RADIO_FAKE") == "1" and "VERCEL" not in env
    default_dir = "/tmp/spaces-radio" if env.get("VERCEL") else str(Path(__file__).resolve().parent.parent / "data")
    data_dir = Path(env.get("SPACES_RADIO_DATA", default_dir)) / ("fake" if fake else "")
    budget = Budget(data_dir / "x-budget.json", _dollars(env, "SPACES_RADIO_DAILY_CAP", DEFAULT_DAILY_CAP))
    if fake:
        print("FAKE X: no network, no cost", flush=True)
        token, fetch = "fake", make_fake_fetch(_seconds(env, "SPACES_RADIO_FAKE_DELAY", FAKE_CREW_DELAY))
    else:
        token, fetch = env.get("X_BEARER_TOKEN", "").strip(), _http_get_json
    source = XApiSource(token, budget, fetch=fetch) if token else None
    key = ticket_key(env, token)
    return RadioService(source, budget, _crew_from_env(env, token, budget, data_dir, fetch),
                        Tickets(key) if key else None)


def _crew_from_env(env, token: str, budget: Budget, data_dir: Path, fetch) -> CrewLookup | None:
    """Names need the key. SPACES_RADIO_CREW=off turns them off with no code change
    (on Vercel, environment changes apply from the next deploy).
    Names and the Space reads made for them get their own ledgers and caps, so crew browsing
    never touches the dial's ledger; a room the dial already paid for today is read for free.
    On Vercel every instance keeps its own ledgers in /tmp: X's spending limit is the real cap."""
    if not token or (env.get("SPACES_RADIO_CREW") or "").strip().lower() == "off":
        return None
    names = Budget(data_dir / "x-crew-budget.json",
                   _dollars(env, "SPACES_RADIO_CREW_DAILY_CAP", DEFAULT_CREW_DAILY_CAP), price=PRICE_PER_USER)
    spaces = Budget(data_dir / "x-crew-spaces.json",
                    _dollars(env, "SPACES_RADIO_CREW_SPACE_CAP", DEFAULT_CREW_SPACE_CAP), price=PRICE_PER_SPACE)
    return CrewLookup(token, spaces, names, fetch=fetch, band_budget=budget)


def _dollars(env, name: str, default: float) -> float:
    """A cap from the environment. Anything that isn't a plain amount spends nothing (fail closed)."""
    raw = (env.get(name) or "").strip()
    if not raw:
        return default
    try:
        value = float(raw)
    except ValueError:
        value = -1.0
    if math.isfinite(value) and value >= 0:
        return value
    print(f"[spaces-radio] {name}={raw[:24]!r} is not a dollar amount; that budget spends nothing")
    return 0.0


def _seconds(env, name: str, default: float) -> float:
    try:
        value = float((env.get(name) or "").strip() or default)
    except ValueError:
        return default
    return min(max(value, 0.0), 5.0) if math.isfinite(value) else default


_shared: RadioService | None = None


def shared_service() -> RadioService:
    """One service per process, so a warm instance keeps its 10-minute cache."""
    global _shared
    if _shared is None:
        _shared = service_from_env()
    return _shared


def write_reply(handler, reply: Reply) -> None:
    """Write a Reply through any BaseHTTPRequestHandler (local server or Vercel)."""
    import json
    handler.send_response(reply.status)
    handler.send_header("Content-Type", "application/json")
    if reply.cdn_seconds:
        handler.send_header("Cache-Control", "public, max-age=30")
        handler.send_header("Vercel-CDN-Cache-Control",
                            f"max-age={reply.cdn_seconds}, stale-while-revalidate=120")
    else:
        handler.send_header("Cache-Control", "no-store")
    for name, value in reply.headers.items():
        handler.send_header(name, value)
    handler.end_headers()
    handler.wfile.write(json.dumps(reply.body).encode("utf-8"))
