"""Where rooms come from (Head First ch. 1, Strategy).

The radio asks a SpaceSource for live rooms on a topic and never cares how
they were found. Today: the X API (paid, guarded). Rooms people paste in live
in their own browser. A shared community list, Clubhouse or Telegram voice
chats later are one new class each; the dial doesn't change.
"""
from __future__ import annotations

import http.client
import json
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Callable, Protocol

from .budget import Budget
from .crew_parse import clean_title
from .space import Space, host_id_list, non_negative_int, parse_space_id

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
FOLLOW_SECONDS = 12.0        # a request waits this long on this instance's search of the same word


class SpaceSource(Protocol):
    name: str

    def live(self, topic: str) -> list[Space]: ...


def _http_get_json(url: str, token: str, timeout: float = 10.0) -> dict:
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


class _Flight:
    """One search in progress on this instance. Requests for the same word wait for its answer."""

    def __init__(self):
        self.done = threading.Event()
        self.rooms: list[Space] | None = None
        self.error: BaseException | None = None

    def follow(self) -> list[Space]:
        if not self.done.wait(FOLLOW_SECONDS):
            raise SourceError("A search for this word is taking too long; try again soon.")
        err = self.error
        if err is None:
            return self.rooms
        # A fresh error per waiter: one exception object raised in many threads shares a traceback.
        if isinstance(err, StaleRooms):
            raise StaleRooms(str(err), err.spaces, err.age)
        if isinstance(err, SourceError):
            raise SourceError(str(err))
        raise SourceError("The search this request waited on failed.")


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
        self._answers = answers  # SharedAnswers: get/put a word's rooms, claim/release/wait on its lease
        self._lock = threading.Lock()
        # Replaced whole under the lock, never edited.
        self._cache: dict[str, tuple[float, list[Space]]] = {}
        self._flights: dict[str, _Flight] = {}  # word -> this instance's search in progress

    def live(self, topic: str) -> list[Space]:
        with self._lock:
            hit = self._cache.get(topic)
            if hit and self._now() - hit[0] < self._ttl:
                return hit[1]
            flight = self._flights.get(topic)
            leading = flight is None
            if leading:
                flight = _Flight()
                self._flights = {**self._flights, topic: flight}
        if not leading:  # this instance is already buying the word: wait for that answer
            return flight.follow()
        try:
            flight.rooms = self._find(topic)
            return flight.rooms
        except BaseException as err:
            flight.error = err
            raise
        finally:
            with self._lock:
                self._flights = {k: v for k, v in self._flights.items() if k != topic}
            flight.done.set()

    def _find(self, topic: str) -> list[Space]:
        shelf = self._answers.get(topic) if self._answers else None
        if shelf and shelf[0] < SHARED_FRESH_SECONDS:  # someone bought this word within the hour: free
            self._remember(topic, self._now() - shelf[0], shelf[1])
            return shelf[1]
        if not self._answers:
            return self._buy(topic, shelf)
        lease = self._answers.claim(topic)
        if lease is None:  # another instance is buying this word right now: its answer will be free
            rooms = self._answers.wait(topic)
            if rooms is not None:
                self._remember(topic, self._now(), rooms)
                return rooms
            lease = self._answers.claim(topic)  # it gave up (X said no, or no fuel): try once ourselves
            if lease is None:
                raise self._still_searching(shelf) if self._answers.held_elsewhere(topic) else self._unconfirmed(shelf)
        try:
            rooms = self._answers.fresh(topic)  # bought and shelved while we were claiming the lease?
            if rooms is not None:
                self._remember(topic, self._now(), rooms)
                return rooms
            return self._buy(topic, shelf)
        finally:
            self._answers.release(topic, lease)

    @staticmethod
    def _still_searching(shelf) -> SourceError:
        if shelf:
            return StaleRooms(f"Another radio is searching this word: showing rooms from {minutes_ago(shelf[0])}.",
                              *shelf[::-1])
        return SourceError("Another radio is searching this word right now; try again in a moment.")

    @staticmethod
    def _unconfirmed(shelf) -> SourceError:
        if shelf:
            return StaleRooms(f"The relay couldn't reserve this search: showing rooms from {minutes_ago(shelf[0])}.",
                              *shelf[::-1])
        return SourceError("The relay couldn't reserve this search; try again in a moment.")

    def _buy(self, topic: str, shelf) -> list[Space]:
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
        items = data if isinstance(data, list) else []
        # X bills every room it returns, including the ticketed and ended ones the dial drops.
        self._budget.settle(held, _returned_ids(items))
        spaces = [s for s in (_to_space(d, topic) for d in items) if s]
        self._remember(topic, self._now(), spaces)
        if self._answers:
            self._answers.put(topic, spaces)
        return spaces

    def _remember(self, topic: str, at: float, spaces: list[Space]) -> None:
        with self._lock:
            self._cache = {**self._cache, topic: (at, spaces)}

    def _search(self, topic: str):
        query = urllib.parse.urlencode({
            "query": topic, "state": "live", "max_results": self._max, "space.fields": FIELDS,
        })
        try:
            return self._fetch(f"{SEARCH_URL}?{query}", self._token)
        except urllib.error.HTTPError as err:
            raise SourceError(_explain_http(err.code)) from err
        # A connection that dies mid-answer is still just a source that couldn't be reached.
        except (urllib.error.URLError, http.client.HTTPException, OSError, TimeoutError, ValueError) as err:
            raise SourceError(f"Couldn't reach X ({err}).") from err


def _explain_http(code: int) -> str:
    return {
        401: "X rejected the key (401). Check X_BEARER_TOKEN.",
        402: "X credits are empty (402): top up at console.x.com.",
        403: "X says this key can't search Spaces (403).",
        429: "X rate limit hit (429); try again in a few minutes.",
    }.get(code, f"X returned an error ({code}).")


def _returned_ids(items: list) -> list[str]:
    """Every room X returned, kept or not. One whose id can't be read was still billed."""
    return [str(d.get("id") or f"unread-{n}")[:40] if isinstance(d, dict) else f"unread-{n}"
            for n, d in enumerate(items)]


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
        title=clean_title(item.get("title")),
        listeners=non_negative_int(item.get("participant_count")),
        # A host on the mic is still one person: speakers are the others at the mic.
        speakers=len(_unique_ids(item.get("speaker_ids")) - host_ids),
        hosts=len(host_ids),
        started_at=str(item.get("started_at") or ""),
        lang=str(item.get("lang") or ""),
        topic=topic,
        source="x-api",
        host_ids=host_id_list(item.get("host_ids")),
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
