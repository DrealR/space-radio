"""The fuel tank: what the radio spends on X, shared by every server instance.

Before this, each Vercel instance kept its own ledger in /tmp, so "today's cap" was really
one cap per instance, and each deploy threw away the shared band answers and paid for them
again. Now both live in one shared store (Vercel's Runtime Cache; plain memory locally):

- SharedBudget: the same Budget, but its ledger is read from and written to the store on
  every step, so all instances add up to one real daily cap.
- SharedAnswers: each search word's rooms, kept an hour as fresh and six hours as stale.
  Fresh means free for everyone; stale is what the dial shows when fuel or X credits run out.
"""
from __future__ import annotations

import hashlib
import sys
import time
from typing import Callable, Optional

from .budget import PRICE_PER_SPACE, Budget, Ledger, utc_day
from .space import Space

FRESH_SECONDS = 3600        # one paid search per word per hour, whoever asks
KEEP_SECONDS = 6 * 3600     # stale rooms stay available this long as a fallback
LEDGER_SECONDS = 2 * 86400  # a day's ledger outlives its day, for the fuel card
StoreGetter = Callable[[], Optional[object]]


def _warn(what: str, err: Exception) -> None:
    print(f"[spaces-radio] fuel {what}: {type(err).__name__}: {err}", file=sys.stderr)


class SharedBudget(Budget):
    """A Budget whose ledger lives in the shared store. If the store is unreachable it keeps
    counting in memory, so an outage can undercount but never unblocks spending by itself."""

    def __init__(self, name: str, store: StoreGetter, daily_cap: float, clock=utc_day,
                 price: float = PRICE_PER_SPACE):
        self._name = name
        self._shared = store
        super().__init__(path=None, daily_cap=daily_cap, clock=clock, price=price)

    def _key(self, day: str) -> str:
        return f"fuel-{self._name}-{day}"

    def _read(self, day: str) -> Optional[Ledger]:
        try:
            store = self._shared()
            raw = store.get(self._key(day)) if store is not None else None
        except Exception as err:
            _warn(f"read {self._name}", err)
            return None
        if not isinstance(raw, dict) or not isinstance(raw.get("paid_ids"), list):
            return None
        return Ledger(day=day, paid_ids=frozenset(str(i) for i in raw["paid_ids"]),
                      calls=int(raw.get("calls", 0)), price=self._price)

    def ledger(self) -> Ledger:
        with self._lock:
            today = self._clock()
            fresh = self._read(today)
            if fresh is not None:
                self._ledger = fresh
            return super().ledger()

    def _load(self) -> Ledger:
        return self._read(self._clock()) or Ledger(day=self._clock(), price=self._price)

    def _save(self) -> None:
        led = self._ledger
        try:
            store = self._shared()
            if store is not None:
                store.set(self._key(led.day), {"paid_ids": sorted(led.paid_ids), "calls": led.calls},
                          {"ttl": LEDGER_SECONDS, "name": "space-radio-fuel"})
        except Exception as err:
            _warn(f"write {self._name}", err)


def _space_from(d: dict) -> Optional[Space]:
    try:
        return Space(id=str(d["id"]), title=str(d.get("title") or "Untitled room"),
                     listeners=int(d.get("listeners") or 0), speakers=int(d.get("speakers") or 0),
                     hosts=int(d.get("hosts") or 0), started_at=str(d.get("started_at") or ""),
                     lang=str(d.get("lang") or ""), topic=str(d.get("topic") or ""),
                     source=str(d.get("source") or "x-api"))
    except (KeyError, TypeError, ValueError):
        return None


class SharedAnswers:
    """Each search word's rooms, shared across instances and deploys."""

    def __init__(self, store: StoreGetter, now: Callable[[], float] = time.time):
        self._shared = store
        self._now = now

    @staticmethod
    def _key(word: str) -> str:
        return "answer-" + hashlib.sha256(word.encode("utf-8")).hexdigest()[:24]

    def get(self, word: str) -> Optional[tuple[float, list[Space]]]:
        """(age in seconds, rooms), or None."""
        try:
            store = self._shared()
            raw = store.get(self._key(word)) if store is not None else None
        except Exception as err:
            _warn("answer read", err)
            return None
        if not isinstance(raw, dict) or not isinstance(raw.get("rooms"), list):
            return None
        rooms = [s for s in (_space_from(d) for d in raw["rooms"] if isinstance(d, dict)) if s]
        return max(0.0, self._now() - float(raw.get("at", 0))), rooms

    def put(self, word: str, rooms: list[Space]) -> None:
        try:
            store = self._shared()
            if store is not None:
                store.set(self._key(word), {"at": self._now(), "rooms": [r.to_json() for r in rooms]},
                          {"ttl": KEEP_SECONDS, "name": "space-radio-answer"})
        except Exception as err:
            _warn("answer write", err)
