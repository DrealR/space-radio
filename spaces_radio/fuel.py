"""The fuel tank: what the radio spends on X, shared by every server instance.

Before this, each Vercel instance kept its own ledger in /tmp, so "today's cap" was really
one cap per instance, and each deploy threw away the shared band answers and paid for them
again. Now both live in one shared store (Vercel's Runtime Cache; plain memory locally):

- SharedBudget: the same Budget, but its ledger is read from and written to the store on
  every step, so all instances add up to one real daily cap.
- SharedAnswers: each search word's rooms, kept an hour as fresh and six hours as stale.
  Fresh means free for everyone; stale is what the dial shows when fuel or X credits run out.

The store can only get and set: no compare-and-set, no counter. Two instances writing at once
would each replace the other's ledger, so three habits keep a race from losing money (Sep 28,
found by the Sky Survey):

- The ledger is a Tank that only grows: spending adds keys, and a hold given back is added to
  `freed`, never deleted. Two copies merge by union, so an instance never trades what it knows
  for an older copy, and a record another write covered up goes back in when its owner looks.
- A hold is announced, then checked: write it, wait a beat, read again. If another instance's
  hold landed meanwhile and together they pass the cap, back off. Of two instances reserving
  the last fuel at once, at most one keeps it (both may back off: that fails closed).
- A word being bought carries a short lease: a second instance waits for that answer instead
  of paying for the same search.

What's left: an instance that stalls longer than the beat between reading and writing can
still slip one hold past a racer. X's prepaid credits stay the hard stop.
"""
from __future__ import annotations

import hashlib
import sys
import time
from dataclasses import dataclass, replace
from typing import Callable, Optional

from .budget import INSTANCE, PRICE_PER_SPACE, Budget, Ledger, hold_keys, mint, utc_day
from .space import Space, host_id_list

FRESH_SECONDS = 3600        # one paid search per word per hour, whoever asks
KEEP_SECONDS = 6 * 3600     # stale rooms stay available this long as a fallback
LEDGER_SECONDS = 2 * 86400  # a day's ledger outlives its day, for the fuel card
RECHECK_SECONDS = 0.1       # the beat between announcing a hold or a lease and looking again
PUBLISH_TRIES = 3           # writes that keep getting covered up before we log it and move on
LEASE_SECONDS = 15          # a word's search lease; X answers within 10 s or times out
WAIT_POLLS = 48             # a second instance checks for the first one's answer this often...
POLL_SECONDS = 0.25         # ...this far apart (12 s in all)
StoreGetter = Callable[[], Optional[object]]
Pause = Callable[[float], None]


def _warn(what: str, err: Exception) -> None:
    print(f"[spaces-radio] fuel {what}: {type(err).__name__}: {err}", file=sys.stderr)


def _strings(raw) -> frozenset:
    return frozenset(str(i) for i in raw) if isinstance(raw, list) else frozenset()


@dataclass(frozen=True)
class Tank:
    """One day of spending in a form any two copies can combine: nothing is ever taken out."""
    day: str
    added: frozenset = frozenset()   # every key ever charged or held today
    freed: frozenset = frozenset()   # holds given back (settled or released)
    calls: frozenset = frozenset()   # one token per paid call

    def merge(self, other: Optional["Tank"]) -> "Tank":
        if other is None or other.day != self.day:
            return self
        return Tank(self.day, self.added | other.added, self.freed | other.freed, self.calls | other.calls)

    def covers(self, other: "Tank") -> bool:
        return other.added <= self.added and other.freed <= self.freed and other.calls <= self.calls

    def hold(self, keys) -> "Tank":
        return replace(self, added=self.added | frozenset(keys))

    def free(self, keys) -> "Tank":
        return replace(self, freed=self.freed | frozenset(keys))

    def spend(self, ids) -> "Tank":
        """One paid call: each id it billed gets its own key, even if another call paid it today."""
        call = mint("call-")
        return replace(self, added=self.added | frozenset(f"{call}:{i}" for i in ids),
                       calls=self.calls | {call})

    def ledger(self, price: float) -> Ledger:
        return Ledger(day=self.day, paid_ids=self.added - self.freed, calls=len(self.calls), price=price)

    def to_json(self) -> dict:
        # "paid_ids" and a numeric "calls" keep the previous version reading during a deploy
        # (it counts given-back holds as spent, which errs toward stopping).
        return {"paid_ids": sorted(self.added), "freed": sorted(self.freed),
                "calls": len(self.calls), "call_ids": sorted(self.calls)}

    @classmethod
    def from_json(cls, day: str, raw) -> Optional["Tank"]:
        if not isinstance(raw, dict) or not isinstance(raw.get("paid_ids"), list):
            return None
        calls = _strings(raw.get("call_ids"))
        if not calls:  # written by the previous version: rebuild its count as stable tokens
            count = raw.get("calls")
            count = count if isinstance(count, int) and not isinstance(count, bool) else 0
            calls = frozenset(f"legacy-{i}" for i in range(max(0, count)))
        return cls(day, _strings(raw["paid_ids"]), _strings(raw.get("freed")), calls)


class SharedBudget(Budget):
    """A Budget whose tank lives in the shared store. If the store is unreachable it keeps
    counting in memory, so an outage can undercount but never unblocks spending by itself."""

    def __init__(self, name: str, store: StoreGetter, daily_cap: float, clock=utc_day,
                 price: float = PRICE_PER_SPACE, pause: Pause = time.sleep):
        self._name = name
        self._shared = store
        self._pause = pause
        super().__init__(path=None, daily_cap=daily_cap, clock=clock, price=price)

    def ledger(self) -> Ledger:
        with self._lock:
            return self._look().ledger(self._price)

    def charge(self, space_ids) -> Ledger:
        return self._change(lambda tank: tank.spend(space_ids))

    def try_reserve(self, count: int, tag: str = "") -> Optional[frozenset]:
        keys = hold_keys(count, tag)
        with self._lock:
            if not self._fits(self._look().ledger(self._price), len(keys)):
                return None
            self._tank = self._tank.hold(keys)
            self._publish()
        self._pause(RECHECK_SECONDS)  # announced; now give a racing instance's hold time to land
        with self._lock:
            if self._look().ledger(self._price).spent <= self._cap + 1e-9:
                return keys
            self._tank = self._tank.free(keys)
            self._publish()
            return None

    def settle(self, held, billed) -> Ledger:
        return self._change(lambda tank: tank.free(held).spend(billed))

    def release(self, held) -> Ledger:
        return self._change(lambda tank: tank.free(held))

    def _change(self, step: Callable[[Tank], Tank]) -> Ledger:
        with self._lock:
            self._tank = step(self._look())
            self._publish()
            return self._tank.ledger(self._price)

    # ---- the store (called with self._lock held) ------------------------------------------------
    def _key(self, day: str) -> str:
        return f"fuel-{self._name}-{day}"

    def _look(self) -> Tank:
        """Today's tank: what we know merged with what the store holds. If the store lost
        something we know (another write covered it, or it was evicted), put it back."""
        today = self._clock()
        mine = self._tank if self._tank.day == today else Tank(today)
        stored = self._read(today)
        self._tank = mine.merge(stored)
        if mine.added and (stored is None or not stored.covers(mine)):
            self._publish()
        return self._tank

    def _publish(self) -> None:
        """Write our tank and read it back; if another write landed on ours, merge and try again."""
        for _ in range(PUBLISH_TRIES):
            if not self._write(self._tank):
                return  # the store is down: keep counting in memory
            stored = self._read(self._tank.day)
            if stored is None or stored.covers(self._tank):
                return
            self._tank = self._tank.merge(stored)
        _warn(f"write {self._name}", RuntimeError(f"covered up {PUBLISH_TRIES} times in a row"))

    def _read(self, day: str) -> Optional[Tank]:
        try:
            store = self._shared()
            raw = store.get(self._key(day)) if store is not None else None
        except Exception as err:
            _warn(f"read {self._name}", err)
            return None
        return Tank.from_json(day, raw)

    def _write(self, tank: Tank) -> bool:
        try:
            store = self._shared()
            if store is None:
                return False
            store.set(self._key(tank.day), tank.to_json(), {"ttl": LEDGER_SECONDS, "name": "space-radio-fuel"})
            return True
        except Exception as err:
            _warn(f"write {self._name}", err)
            return False

    def _load(self) -> Ledger:
        today = self._clock()
        self._tank = Tank(today).merge(self._read(today))
        return self._tank.ledger(self._price)


def _space_from(d: dict) -> Optional[Space]:
    try:
        return Space(id=str(d["id"]), title=str(d.get("title") or "Untitled room"),
                     listeners=int(d.get("listeners") or 0), speakers=int(d.get("speakers") or 0),
                     hosts=int(d.get("hosts") or 0), started_at=str(d.get("started_at") or ""),
                     lang=str(d.get("lang") or ""), topic=str(d.get("topic") or ""),
                     source=str(d.get("source") or "x-api"), host_ids=host_id_list(d.get("host_ids")))
    except (KeyError, TypeError, ValueError):
        return None


class SharedAnswers:
    """Each search word's rooms, shared across instances and deploys, plus a lease on each
    word while one instance is buying it."""

    def __init__(self, store: StoreGetter, now: Callable[[], float] = time.time, pause: Pause = time.sleep):
        self._shared = store
        self._now = now
        self._pause = pause

    @staticmethod
    def _key(word: str, kind: str = "answer") -> str:
        return f"{kind}-" + hashlib.sha256(word.encode("utf-8")).hexdigest()[:24]

    def get(self, word: str) -> Optional[tuple[float, list[Space]]]:
        """(age in seconds, rooms), or None."""
        raw = self._get(self._key(word), "answer read")
        if not isinstance(raw, dict) or not isinstance(raw.get("rooms"), list):
            return None
        rooms = [s for s in (_space_from(d) for d in raw["rooms"] if isinstance(d, dict)) if s]
        return max(0.0, self._now() - float(raw.get("at", 0))), rooms

    def put(self, word: str, rooms: list[Space]) -> None:
        self._set(self._key(word), {"at": self._now(), "rooms": [r.to_json() for r in rooms]},
                  {"ttl": KEEP_SECONDS, "name": "space-radio-answer"}, "answer write")

    # ---- the lease: one instance buys a word at a time ---------------------------------------------
    def claim(self, word: str) -> Optional[str]:
        """Take this word's search. Returns the lease, or None while another instance holds it.
        Write, wait a beat, read back: of two instances claiming at once, one keeps it."""
        if self._holder(word) not in (None, "mine"):
            return None
        lease = mint()
        if not self._set(self._key(word, "lease"), {"owner": lease, "until": self._now() + LEASE_SECONDS},
                         {"ttl": LEASE_SECONDS, "name": "space-radio-lease"}, "lease write"):
            return lease  # no store to share a lease through: the budget still guards the spend
        self._pause(RECHECK_SECONDS)
        raw = self._get(self._key(word, "lease"), "lease read")
        return lease if not isinstance(raw, dict) or raw.get("owner") == lease else None

    def release(self, word: str, lease: str) -> None:
        raw = self._get(self._key(word, "lease"), "lease read")
        if isinstance(raw, dict) and raw.get("owner") == lease:
            self._set(self._key(word, "lease"), {"owner": lease, "until": 0},
                      {"ttl": LEASE_SECONDS, "name": "space-radio-lease"}, "lease write")

    def wait(self, word: str) -> Optional[list[Space]]:
        """Rooms the lease holder bought, once they're shelved; None if it gave up or took too long."""
        for _ in range(WAIT_POLLS):
            self._pause(POLL_SECONDS)
            shelf = self.get(word)
            if shelf and shelf[0] < FRESH_SECONDS:
                return shelf[1]
            if self._holder(word) is None:
                return None
        return None

    def _holder(self, word: str) -> Optional[str]:
        """Who holds this word's lease: None (nobody), "mine" (this instance) or "other"."""
        raw = self._get(self._key(word, "lease"), "lease read")
        if not isinstance(raw, dict) or not isinstance(raw.get("until"), (int, float)):
            return None
        if raw["until"] <= self._now():
            return None
        return "mine" if str(raw.get("owner", "")).startswith(f"{INSTANCE}.") else "other"

    def _get(self, key: str, what: str):
        try:
            store = self._shared()
            return store.get(key) if store is not None else None
        except Exception as err:
            _warn(what, err)
            return None

    def _set(self, key: str, value: dict, options: dict, what: str) -> bool:
        try:
            store = self._shared()
            if store is None:
                return False
            store.set(key, value, options)
            return True
        except Exception as err:
            _warn(what, err)
            return False
