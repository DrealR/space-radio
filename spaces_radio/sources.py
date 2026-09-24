"""Where rooms come from (Head First ch. 1, Strategy).

The radio asks a SpaceSource for live rooms on a topic and never cares how
they were found. Today: the X API (paid, guarded). Rooms people paste in live
in their own browser. A shared community list, Clubhouse or Telegram voice
chats later are one new class each; the dial doesn't change.
"""
from __future__ import annotations

import json
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Callable, Protocol

from .budget import Budget
from .space import Space, parse_space_id

SEARCH_URL = "https://api.x.com/2/spaces/search"
# host_ids / speaker_ids are plain id lists on the Space (no user lookups, no extra cost).
FIELDS = "title,participant_count,started_at,lang,state,is_ticketed,host_ids,speaker_ids"


class SourceError(Exception):
    """A source failed in a way the listener should hear about."""


class SpaceSource(Protocol):
    name: str

    def live(self, topic: str) -> list[Space]: ...


def _http_get_json(url: str, token: str, timeout: float = 10.0) -> dict:
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


class XApiSource:
    """Live Spaces from X search. Costs money, so every call passes the Budget
    first and results are cached per topic so the dial can't hammer the API."""

    name = "x-api"

    def __init__(self, token: str, budget: Budget, max_results: int = 10,
                 cache_seconds: int = 600, fetch: Callable[[str, str], dict] = _http_get_json,
                 now: Callable[[], float] = time.time):
        if not token:
            raise ValueError("XApiSource needs a bearer token")
        self._token = token
        self._budget = budget
        self._max = max(1, min(100, max_results))
        self._ttl = cache_seconds
        self._fetch = fetch
        self._now = now
        self._cache: dict[str, tuple[float, list[Space]]] = {}

    def live(self, topic: str) -> list[Space]:
        hit = self._cache.get(topic)
        if hit and self._now() - hit[0] < self._ttl:
            return hit[1]
        if not self._budget.can_afford(self._max):
            raise SourceError("Today's X budget is used up; rooms people pasted still play.")
        query = urllib.parse.urlencode({
            "query": topic, "state": "live", "max_results": self._max, "space.fields": FIELDS,
        })
        try:
            body = self._fetch(f"{SEARCH_URL}?{query}", self._token)
        except urllib.error.HTTPError as err:
            raise SourceError(_explain_http(err.code)) from err
        except (urllib.error.URLError, TimeoutError, ValueError) as err:
            raise SourceError(f"Couldn't reach X ({err}).") from err
        spaces = [s for s in (_to_space(d, topic) for d in body.get("data") or []) if s]
        self._budget.charge(s.id for s in spaces)
        self._cache = {**self._cache, topic: (self._now(), spaces)}
        return spaces


def _explain_http(code: int) -> str:
    return {
        401: "X rejected the key (401). Check X_BEARER_TOKEN.",
        402: "X says the account is out of credits (402).",
        403: "X says this key can't search Spaces (403).",
        429: "X rate limit hit (429); try again in a few minutes.",
    }.get(code, f"X returned an error ({code}).")


def _to_space(item: dict, topic: str) -> Space | None:
    space_id = parse_space_id(str(item.get("id", "")))
    if not space_id or item.get("is_ticketed"):
        return None
    if item.get("state", "live") != "live":
        return None
    return Space(
        id=space_id,
        title=str(item.get("title") or "Untitled room")[:200],
        listeners=int(item.get("participant_count") or 0),
        speakers=len(item.get("speaker_ids") or []),
        hosts=len(item.get("host_ids") or []),
        started_at=str(item.get("started_at") or ""),
        lang=str(item.get("lang") or ""),
        topic=topic,
        source="x-api",
    )


def gather(sources: list[SpaceSource], topic: str) -> tuple[list[Space], list[str]]:
    """Ask every source; one failing source doesn't silence the others.
    Live rooms first (busiest first), each room once."""
    found: dict[str, Space] = {}
    problems: list[str] = []
    for source in sources:
        try:
            for space in source.live(topic):
                found.setdefault(space.id, space)
        except SourceError as err:
            problems.append(f"{source.name}: {err}")
    ordered = sorted(found.values(), key=lambda s: (not s.live, -s.listeners))
    return ordered, problems
