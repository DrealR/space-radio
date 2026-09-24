"""What the radio answers, independent of who serves it.

The local dev server and the Vercel functions both call RadioService and
write its Reply; neither knows about X, budgets or caching rules.

Cost shape: one shared key, many listeners. Replies carry a CDN lifetime, so
everyone tuned to "music" in the same ten minutes gets the same cached answer
and X is asked once. X also bills each room once per UTC day, so spend follows
how many distinct rooms appear, not how many people listen.
"""
from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

from .budget import DEFAULT_DAILY_CAP, Budget
from .sources import SourceError, SpaceSource, XApiSource
from .stations import STATIONS, tune

FRESH_SECONDS = 600     # a good answer is shared for 10 minutes
TROUBLE_SECONDS = 60    # a partial or failed answer is retried sooner
STATUS_SECONDS = 300
ALLOWED_PARAMS = {"station"}


@dataclass(frozen=True)
class Reply:
    status: int
    body: dict
    cdn_seconds: int = 0
    headers: dict = field(default_factory=dict)


def envelope(data=None, error: str | None = None, meta: dict | None = None) -> dict:
    return {"success": error is None, "data": data, "error": error, "meta": meta or {}}


class RadioService:
    def __init__(self, source: SpaceSource | None, budget: Budget):
        self._source = source
        self._budget = budget

    @property
    def live_search(self) -> bool:
        return self._source is not None

    def status(self) -> Reply:
        return Reply(200, envelope({"live_search": self.live_search, "stations": list(STATIONS)}),
                     STATUS_SECONDS)

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
        return Reply(200, envelope([r.to_json() for r in rooms],
                                   meta={"station": station, "problems": problems}), seconds)


def service_from_env(env=os.environ) -> RadioService:
    """Token from X_BEARER_TOKEN. On Vercel only /tmp is writable, so the
    budget there is a per-instance soft guard; X's own spending limit is the hard cap."""
    default_dir = "/tmp/spaces-radio" if env.get("VERCEL") else str(Path(__file__).resolve().parent.parent / "data")
    data_dir = Path(env.get("SPACES_RADIO_DATA", default_dir))
    cap = float(env.get("SPACES_RADIO_DAILY_CAP", DEFAULT_DAILY_CAP))
    budget = Budget(data_dir / "x-budget.json", cap)
    token = env.get("X_BEARER_TOKEN", "").strip()
    return RadioService(XApiSource(token, budget) if token else None, budget)


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
