"""Who is aboard a Space: the host, co-hosts and speakers, named by X.

Names cost money: X bills every user it returns ($0.010, once per UTC day).
So a lookup runs only when a listener asks, answers are cached and shared,
and separate daily ledgers cap the spend. crew_parse.py is the pure half;
CrewLookup does the paid I/O around it:

1. A probe asks X for the Space alone: its state and plain id lists, no names.
   It costs one Space read ($0.005, once a day). A room that isn't live stops here.
2. A live room is priced from the probe's id lists, then looked up with names:
   the whole crew if the ledger can hold everyone plus a small margin and the
   request carries a ticket from the radio's own search, else the host alone.

Several requests can arrive at once. Each paid step reserves its worst case under
a lock before X is called and settles what X billed afterwards. A request for a room
that is already being scanned waits for that scan instead of paying again. After X
refuses the whole app (busy, out of credits, bad key), nobody asks again for a while.
"""
from __future__ import annotations

import http.client
import sys
import threading
import time
import urllib.error
from dataclasses import replace
from datetime import datetime, timezone
from typing import Callable, Optional, Tuple

from .budget import Budget
from .crew_parse import (CREW_ID, EXPANSIONS, MAX_CREW, MESSAGES, CrewError, CrewScan, billed_ids, crew_ids,
                         crew_url, parse_crew, valid_crew_id)
from .people import AVATAR_HOSTS, USER_ID, USERNAME, Person, normalize_person
from .sources import _http_get_json

__all__ = ["AVATAR_HOSTS", "CREW_ID", "EXPANSIONS", "MAX_CREW", "MESSAGES", "USER_ID", "USERNAME",
           "CrewError", "CrewLookup", "CrewScan", "Person", "crew_url", "normalize_person", "parse_crew",
           "valid_crew_id"]

LIVE_SECONDS = 120          # a live roster changes as people take the mic
SETTLED_SECONDS = 600       # ended and scheduled rooms don't change
MAX_CALLS_PER_MINUTE = 30   # per instance; random ids can't hammer X through the radio
JOIN_MARGIN = 3             # people who may take the mic between the probe and the lookup
FOLLOW_TIMEOUT = 45.0       # seconds a request waits on another request's scan of the same room
# X refused the whole app, not one room: every room waits this long before X is asked again.
HOLD_SECONDS = {"rate": 30, "credits": 60, "auth": 60}
_HTTP_REASONS = {401: "auth", 402: "credits", 403: "auth", 429: "rate"}
_GONE = {"errors": [{"title": "Not Found (HTTP 404)"}]}  # parse_crew reads this as "ended"


def _iso_utc(epoch: float) -> str:
    return datetime.fromtimestamp(epoch, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _log_line(text: str) -> None:
    sys.stderr.write(text + "\n")


def _ttl(scan: CrewScan) -> int:
    return LIVE_SECONDS if scan.state == "live" else SETTLED_SECONDS


class _Flight:
    """One scan in progress. Requests for the same room meanwhile wait for its answer."""

    def __init__(self):
        self.done = threading.Event()
        self.scan: Optional[CrewScan] = None
        self.error: Optional[BaseException] = None


class CrewLookup:
    """One paid lookup per room at a time: cached, capped, rate-guarded, logged without names."""

    def __init__(self, token: str, space_budget: Budget, user_budget: Budget,
                 fetch: Callable[[str, str], dict] = _http_get_json,
                 now: Callable[[], float] = time.time, log: Callable[[str], None] = _log_line,
                 max_calls_per_minute: int = MAX_CALLS_PER_MINUTE, band_budget: Optional[Budget] = None):
        if not token:
            raise ValueError("CrewLookup needs a bearer token")
        self._token = token
        self._spaces = space_budget  # Space reads made for names
        self._users = user_budget
        self._band = band_budget     # read only: a room the dial paid for today costs nothing again
        self._fetch = fetch
        self._now = now
        self._log = log
        self._max_calls = max(1, max_calls_per_minute)
        self._lock = threading.Lock()
        # All replaced whole under the lock, never edited.
        self._cache: dict = {}       # id -> (fetched at, CrewScan)
        self._calls: tuple = ()      # when recent upstream calls happened
        self._flights: dict = {}     # id -> _Flight
        self._hold: tuple = ()       # (reason, until) after X refused the whole app

    def scan(self, space_id: str, trusted: bool = True) -> Tuple[CrewScan, bool]:
        """(CrewScan, served from cache or another request's scan). Raises CrewError;
        errors are never cached. Untrusted requests (no ticket) get the host at most."""
        sid = valid_crew_id(space_id)
        if not sid:
            raise CrewError("bad-id")
        with self._lock:
            at = self._now()
            hit = self._cache.get(sid)
            if hit and at - hit[0] < _ttl(hit[1]):
                return hit[1], True
            flight = self._flights.get(sid)
            leading = flight is None
            if leading:
                self._check_hold(at)
                self._floor(sid)
                flight = _Flight()
                self._flights = {**self._flights, sid: flight}
        return self._lead(sid, at, trusted, flight) if leading else self._follow(flight)

    # ---- one scan per room, shared ------------------------------------------------------
    def _lead(self, sid: str, at: float, trusted: bool, flight: _Flight) -> Tuple[CrewScan, bool]:
        try:
            flight.scan = replace(self._lookup(sid, trusted), fetched_at=_iso_utc(at))
            return flight.scan, False
        except BaseException as err:
            flight.error = err
            raise
        finally:
            with self._lock:
                if flight.scan is not None:
                    fresh = {k: v for k, v in self._cache.items() if at - v[0] < _ttl(v[1])}
                    self._cache = {**fresh, sid: (at, flight.scan)}
                self._flights = {k: v for k, v in self._flights.items() if k != sid}
            flight.done.set()

    @staticmethod
    def _follow(flight: _Flight) -> Tuple[CrewScan, bool]:
        if not flight.done.wait(FOLLOW_TIMEOUT):
            raise CrewError("offline", "waited too long on another scan of this room")
        err = flight.error
        if err is None:
            return flight.scan, True
        # A fresh error per waiter: one exception object raised in many threads shares a traceback.
        if isinstance(err, CrewError):
            raise CrewError(err.reason, err.detail)
        raise CrewError("upstream", "the scan this request waited on crashed")

    def _lookup(self, sid: str, trusted: bool) -> CrewScan:
        probe_body = self._probe(sid)
        probe = self._read(probe_body, sid, "probe", 0)
        if probe.state != "live":
            self._log_spend(sid, "probe", 0)
            return replace(probe, mode="full")  # no names to show, so nothing was held back
        mode, held, need = self._reserve_names(sid, probe_body, trusted)
        return self._named(sid, mode, held, need)

    # ---- the paid steps ---------------------------------------------------------------------
    def _probe(self, sid: str) -> dict:
        """The Space alone: state, counts and id lists. Pays one Space read, never names."""
        held = self._reserve_space(sid)
        try:
            body = self._call(sid, "probe")
        except BaseException:
            if held:
                self._spaces.release(held)
            raise
        if held:
            came_back = isinstance(body, dict) and isinstance(body.get("data"), dict)
            self._spaces.settle(held, [sid] if came_back else [])
        stray = billed_ids(body, sid)  # X names nobody on a probe; if it ever does, it bills them
        if stray:
            self._users.charge(stray)
        return body

    def _reserve_space(self, sid: str) -> frozenset:
        """Hold one Space read for the probe. X bills it even if the dial saw the room today."""
        held = self._spaces.try_reserve(1, tag=sid)
        if held is None:
            raise self._refuse(sid, "probe", "budget", f"crew Space-read cap ${self._spaces.cap:.2f} reached")
        return held

    def _reserve_names(self, sid: str, probe_body: dict, trusted: bool) -> Tuple[str, frozenset, int]:
        """Price the crew from the probe's id lists: hold everyone if it fits, else the host."""
        if trusted:
            need = len(crew_ids(probe_body)) + JOIN_MARGIN  # every name is billed on every scan
            held = self._users.try_reserve(need, tag=sid)
            if held is not None:
                return "full", held, need
        held = self._users.try_reserve(1, tag=sid)
        if held is None:
            raise self._refuse(sid, "host-only", "budget", f"crew cap ${self._users.cap:.2f} reached")
        return "host-only", held, 1

    def _named(self, sid: str, mode: str, held: frozenset, need: int) -> CrewScan:
        try:
            body = self._call(sid, mode)
        except BaseException:
            self._users.release(held)
            raise
        billed = billed_ids(body, sid)
        self._users.settle(held, billed)
        if len(billed) > need:
            self._log(f"[spaces-radio] crew {sid} {mode} scan billed {len(billed)} users, expected <= {need}")
        scan = self._read(body, sid, mode, len(billed))
        self._log_spend(sid, mode, len(billed))
        return scan if scan.state == "live" else replace(scan, mode="full")

    def _call(self, sid: str, mode: str):
        with self._lock:
            self._admit(sid, self._now())
        try:
            return self._fetch(crew_url(sid, mode), self._token)
        except urllib.error.HTTPError as err:
            if err.code == 404:
                return _GONE
            reason = _HTTP_REASONS.get(err.code, "upstream")
            self._hold_after(reason)
            raise self._refuse(sid, mode, reason, f"HTTP {err.code}") from err
        except (urllib.error.URLError, http.client.HTTPException, OSError) as err:
            raise self._refuse(sid, mode, "offline", type(err).__name__) from err
        except ValueError as err:
            raise self._refuse(sid, mode, "upstream", "unreadable JSON") from err

    def _read(self, body, sid: str, mode: str, billed: int) -> CrewScan:
        try:
            return parse_crew(body, sid, mode)
        except CrewError as err:
            raise self._refuse(sid, mode, err.reason, f"{err.detail}; users={billed}") from err

    # ---- guards (called with self._lock held, except _hold_after) --------------------------
    def _check_hold(self, at: float) -> None:
        if self._hold and at < self._hold[1]:
            raise CrewError(self._hold[0], "held after X refused")  # not logged: once per press is noise

    def _hold_after(self, reason: str) -> None:
        if reason in HOLD_SECONDS:
            with self._lock:
                self._hold = (reason, self._now() + HOLD_SECONDS[reason])

    def _floor(self, sid: str) -> None:
        if not self._users.can_afford(1):
            raise self._refuse(sid, "-", "budget", f"crew cap ${self._users.cap:.2f} reached")

    def _admit(self, sid: str, at: float) -> None:
        recent = tuple(t for t in self._calls if at - t < 60)
        if len(recent) >= self._max_calls:
            self._calls = recent
            raise self._refuse(sid, "-", "rate", f"local guard: {self._max_calls} calls a minute")
        self._calls = recent + (at,)

    def _log_spend(self, sid: str, mode: str, users: int) -> None:
        spent = self._users.ledger().spent
        self._log(f"[spaces-radio] crew {sid} mode={mode} users={users} crew_spent_today=${spent:.3f}")

    def _refuse(self, sid: str, mode: str, reason: str, detail: str) -> CrewError:
        self._log(f"[spaces-radio] crew {sid} mode={mode} refused reason={reason} ({detail})")
        return CrewError(reason, detail)
