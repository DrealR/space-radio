"""A daily spending guard for the X API.

X bills $0.005 per Space returned and $0.010 per user returned, and counts
each id once per UTC day. A ledger remembers which ids were already paid for
today, refuses a call whose worst case would pass the cap, and survives
restarts in a small JSON file. Rooms and names keep separate ledgers, so
looking up who's aboard can never starve the dial.

A server answers several requests at once, so a check followed later by a
charge could let two requests spend the same last dollar. Paid calls therefore
reserve their worst case first (try_reserve), then settle what X actually
billed, or release the reservation when the call fails. Every step holds a lock
and replaces the ledger whole; the file is written to a temp file and renamed.
"""
from __future__ import annotations

import itertools
import json
import os
import threading
from dataclasses import dataclass, field, replace
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

PRICE_PER_SPACE = 0.005
PRICE_PER_USER = 0.010          # every user in includes.users is billed
DEFAULT_DAILY_CAP = 0.50        # dollars; ~100 distinct Spaces a day
DEFAULT_CREW_DAILY_CAP = 0.50   # dollars; ~50 new names a day (a full crew is ~9-15). Per instance on Vercel.
DEFAULT_CREW_SPACE_CAP = 0.10   # dollars; ~20 rooms a day looked up by name, off the dial's ledger

_holds = itertools.count()      # reservation keys are unique within this process


def utc_day(now: datetime | None = None) -> str:
    return (now or datetime.now(timezone.utc)).strftime("%Y-%m-%d")


@dataclass(frozen=True)
class Ledger:
    day: str
    paid_ids: frozenset = field(default_factory=frozenset)
    calls: int = 0
    price: float = PRICE_PER_SPACE

    @property
    def spent(self) -> float:
        return round(len(self.paid_ids) * self.price, 4)


class Budget:
    def __init__(self, path: Path, daily_cap: float = DEFAULT_DAILY_CAP, clock=utc_day,
                 price: float = PRICE_PER_SPACE):
        if price <= 0:
            raise ValueError("a Budget needs a positive price per id")
        self._path = path
        self._cap = daily_cap
        self._clock = clock
        self._price = price
        self._lock = threading.RLock()  # re-entrant: charge() reads ledger() while holding it
        self._ledger = self._load()

    @property
    def cap(self) -> float:
        return self._cap

    def ledger(self) -> Ledger:
        with self._lock:
            today = self._clock()
            if self._ledger.day != today:
                self._ledger = Ledger(day=today, price=self._price)
            return self._ledger

    def can_afford(self, max_results: int) -> bool:
        with self._lock:
            return self._fits(self.ledger(), max_results)

    def charge(self, space_ids) -> Ledger:
        with self._lock:
            current = self.ledger()
            return self._store(replace(current, paid_ids=current.paid_ids | frozenset(space_ids),
                                       calls=current.calls + 1))

    def try_reserve(self, count: int, tag: str = "") -> Optional[frozenset]:
        """Hold room for `count` new ids. Returns the held keys (settle or release them), or
        None, holding nothing, when the worst case could pass the cap."""
        keys = frozenset(f"hold-{tag}-{os.getpid()}-{next(_holds)}" for _ in range(max(0, count)))
        with self._lock:
            current = self.ledger()
            if not self._fits(current, len(keys)):
                return None
            self._store(replace(current, paid_ids=current.paid_ids | keys))
            return keys

    def settle(self, held, billed) -> Ledger:
        """Swap a reservation for the ids X actually billed."""
        with self._lock:
            current = self.ledger()
            paid = (current.paid_ids - frozenset(held)) | frozenset(billed)
            return self._store(replace(current, paid_ids=paid, calls=current.calls + 1))

    def release(self, held) -> Ledger:
        """The call failed and X billed nothing: give the reservation back."""
        with self._lock:
            current = self.ledger()
            return self._store(replace(current, paid_ids=current.paid_ids - frozenset(held)))

    def status(self) -> dict:
        with self._lock:
            led = self.ledger()
        return {"day": led.day, "spent": led.spent, "cap": self._cap,
                "calls": led.calls, "spaces_paid": len(led.paid_ids)}

    def _fits(self, led: Ledger, count: int) -> bool:
        return led.spent + count * self._price <= self._cap + 1e-9

    def _store(self, led: Ledger) -> Ledger:
        # Memory first: even if the disk refuses, this process keeps counting.
        self._ledger = led
        self._save()
        return led

    def _load(self) -> Ledger:
        # The price is this Budget's, not the file's: files written before prices existed load as-is.
        try:
            raw = json.loads(self._path.read_text())
            if not isinstance(raw.get("paid_ids"), list):
                raise TypeError("paid_ids is not a list")
            return Ledger(day=str(raw["day"]), paid_ids=frozenset(raw["paid_ids"]),
                          calls=int(raw["calls"]), price=self._price)
        except FileNotFoundError:
            return Ledger(day=self._clock(), price=self._price)
        except (ValueError, KeyError, TypeError, AttributeError) as err:
            # A damaged ledger must not reset spend to zero silently: assume today is used up.
            print(f"[spaces-radio] budget ledger {self._path.name} unreadable ({err}); treating today as spent")
            return Ledger(day=self._clock(), price=self._price, paid_ids=frozenset(
                f"unknown-{i}" for i in range(int(self._cap / self._price) + 1)))

    def _save(self) -> None:
        """Write a temp file, then rename it over the ledger: a reader never sees half a file."""
        led = self._ledger
        text = json.dumps({"day": led.day, "paid_ids": sorted(str(i) for i in led.paid_ids),
                           "calls": led.calls, "price": led.price}, indent=1)
        self._path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self._path.with_name(f"{self._path.name}.{os.getpid()}.{threading.get_ident()}.tmp")
        try:
            tmp.write_text(text)
            os.replace(tmp, self._path)
        except OSError:
            try:
                tmp.unlink()
            except OSError:
                pass  # nothing was written, or it's already gone
            raise
