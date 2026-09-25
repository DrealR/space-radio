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
from .space import Space, non_negative_int, parse_space_id

SEARCH_URL = "https://api.x.com/2/spaces/search"
# host_ids / speaker_ids are plain id lists on the Space (no user lookups, no extra cost).
FIELDS = "title,participant_count,started_at,lang,state,is_ticketed,host_ids,speaker_ids"


class SourceError(Exception):
    """A source failed in a way the listener should hear about."""


class StaleRooms(SourceError):
    """No fresh answer could be bought (out of fuel, or X said no), but an older one is on the shelf."""

    def __init__(self, message: str, spaces: list, age_seconds: float):
        super().__init__(message)
        self.spaces = spaces
        self.age = age_seconds


def minutes_ago(seconds: float) -> str:
    minutes = int(seconds // 60)
    return "just now" if minutes < 1 else f"{minutes} min ago" if minutes < 90 else f"{minutes // 60} h ago"


SHARED_FRESH_SECONDS = 3600  # a word's shared answer is bought at most once an hour


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
                 now: Callable[[], float] = time.time, answers=None):
        if not token:
            raise ValueError("XApiSource needs a bearer token")
        self._token = token
        self._budget = budget
        self._max = max(1, min(100, max_results))
        self._ttl = cache_seconds
        self._fetch = fetch
        self._now = now
        self._cache: dict[str, tuple[float, list[Space]]] = {}
        self._answers = answers  # SharedAnswers: get(word) -> (age, rooms) | None, put(word, rooms)

    def live(self, topic: str) -> list[Space]:
        hit = self._cache.get(topic)
        if hit and self._now() - hit[0] < self._ttl:
            return hit[1]
        shelf = self._answers.get(topic) if self._answers else None
        if shelf and shelf[0] < SHARED_FRESH_SECONDS:  # someone bought this word within the hour: free
            self._cache = {**self._cache, topic: (self._now() - shelf[0], shelf[1])}
            return shelf[1]
        # Hold the worst case before asking, so requests arriving together can't all pass the cap.
        held = self._budget.try_reserve(self._max, tag="search")
        if held is None:
            if shelf:
                raise StaleRooms(f"Today's X fuel is used up: showing rooms from {minutes_ago(shelf[0])}.", *shelf[::-1])
            raise SourceError("Today's X fuel is used up; rooms people pasted still play.")
        try:
            body = self._search(topic)
        except SourceError as err:
            self._budget.release(held)
            if shelf:
                raise StaleRooms(f"{err} Showing rooms from {minutes_ago(shelf[0])}.", *shelf[::-1]) from err
            raise
        except BaseException:
            self._budget.release(held)
            raise
        data = body.get("data") if isinstance(body, dict) else None
        spaces = [s for s in (_to_space(d, topic) for d in (data if isinstance(data, list) else [])) if s]
        self._budget.settle(held, [s.id for s in spaces])
        self._cache = {**self._cache, topic: (self._now(), spaces)}
        if self._answers:
            self._answers.put(topic, spaces)
        return spaces

    def _search(self, topic: str):
        query = urllib.parse.urlencode({
            "query": topic, "state": "live", "max_results": self._max, "space.fields": FIELDS,
        })
        try:
            return self._fetch(f"{SEARCH_URL}?{query}", self._token)
        except urllib.error.HTTPError as err:
            raise SourceError(_explain_http(err.code)) from err
        except (urllib.error.URLError, TimeoutError, ValueError) as err:
            raise SourceError(f"Couldn't reach X ({err}).") from err


def _explain_http(code: int) -> str:
    return {
        401: "X rejected the key (401). Check X_BEARER_TOKEN.",
        402: "X credits are empty (402): top up at console.x.com.",
        403: "X says this key can't search Spaces (403).",
        429: "X rate limit hit (429); try again in a few minutes.",
    }.get(code, f"X returned an error ({code}).")


def _to_space(item: dict, topic: str) -> Space | None:
    if not isinstance(item, dict):
        return None
    space_id = parse_space_id(str(item.get("id", "")))
    if not space_id or item.get("is_ticketed"):
        return None
    if item.get("state", "live") != "live":
        return None
    host_ids = _unique_ids(item.get("host_ids"))
    return Space(
        id=space_id,
        title=str(item.get("title") or "Untitled room")[:200],
        listeners=non_negative_int(item.get("participant_count")),
        # A host on the mic is still one person: speakers are the others at the mic.
        speakers=len(_unique_ids(item.get("speaker_ids")) - host_ids),
        hosts=len(host_ids),
        started_at=str(item.get("started_at") or ""),
        lang=str(item.get("lang") or ""),
        topic=topic,
        source="x-api",
    )


def _unique_ids(raw) -> frozenset:
    if not isinstance(raw, list):
        return frozenset()
    return frozenset(str(i) for i in raw if isinstance(i, (str, int)) and not isinstance(i, bool))


def gather(sources: list[SpaceSource], topic: str) -> tuple[list[Space], list[str]]:
    """Ask every source; one failing source doesn't silence the others.
    Live rooms first (busiest first), each room once."""
    found: dict[str, Space] = {}
    problems: list[str] = []
    for source in sources:
        try:
            for space in source.live(topic):
                found.setdefault(space.id, space)
        except StaleRooms as err:  # older rooms beat an empty dial
            for space in err.spaces:
                found.setdefault(space.id, space)
            problems.append(str(err))
        except SourceError as err:
            problems.append(f"{source.name}: {err}")
    ordered = sorted(found.values(), key=lambda s: (not s.live, -s.listeners))
    return ordered, problems
