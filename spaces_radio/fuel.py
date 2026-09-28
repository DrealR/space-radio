"""The fuel tank: what the radio spends on X, shared by every server instance.

Before this, each Vercel instance kept its own ledger in /tmp, so "today's cap" was really
one cap per instance, and each deploy threw away the shared band answers and paid for them
again. Now both live in one shared store (Vercel's Runtime Cache; plain memory locally):

- SharedBudget: the same Budget, but its ledger is read from and written to the store on
  every step, so all instances add up to one real daily cap.
- SharedAnswers: each search word's rooms, kept an hour as fresh and six hours as stale.
  Fresh means free for everyone; stale is what the dial shows when fuel or X credits run out.

The store can only get and set: no compare-and-set, no counter. Two instances writing at once
would each replace the other's ledger, so four habits keep a race from losing money (Sep 28,
found by the Sky Survey, tightened after review):

- The ledger is a Tank of tallies, one per writer. A writer only ever raises its own numbers
  and copies merge by taking the larger of each, so no write lands "backwards", and every copy
  carries every tally its writer has seen: a tally another write covered up comes back with
  the next write from anyone who saw it. It stays small: a few numbers per instance.
- Nothing is written after a failed read (that copy could be old), and no fuel is granted
  while the tank can't be read. Spending still counts in memory and goes out with the next write.
- A hold is announced, then checked: write it, wait a beat, read again. If another instance's
  hold landed meanwhile and together they pass the cap, back off. Of two instances reserving
  the last fuel at once, at most one keeps it (both may back off: that fails closed). A charge
  is looked at again after the same beat, so a write that covered it up gets undone.
- A word being bought carries a short lease: a second instance waits for that answer instead
  of paying for the same search.

What's left: an instance that stalls longer than the beat between reading and writing can
still slip one hold past a racer. X's prepaid credits stay the hard stop.
"""
from __future__ import annotations

import hashlib
import sys
import time
from dataclasses import dataclass, field, replace
from typing import Callable, NamedTuple, Optional

from .budget import PRICE_PER_SPACE, Budget, Ledger, hold_keys, mint, utc_day
from .space import Space, host_id_list

FRESH_SECONDS = 3600        # one paid search per word per hour, whoever asks
KEEP_SECONDS = 6 * 3600     # stale rooms stay available this long as a fallback
LEDGER_SECONDS = 2 * 86400  # a day's ledger outlives its day, for the fuel card
RECHECK_SECONDS = 0.1       # the beat between announcing a hold, charge or lease and looking again
PUBLISH_TRIES = 3           # writes that keep getting covered up before we log it and move on
LEASE_SECONDS = 15          # a word's search lease; X answers within 10 s or times out
WAIT_POLLS = 20             # a second instance checks for the first one's answer this often...
POLL_SECONDS = 0.25         # ...this far apart (5 s in all, inside Vercel's 30 s per request)
StoreGetter = Callable[[], Optional[object]]
Pause = Callable[[float], None]


def _warn(what: str, err: Exception) -> None:
    print(f"[spaces-radio] fuel {what}: {type(err).__name__}: {err}", file=sys.stderr)


def _count(raw) -> int:
    return raw if isinstance(raw, int) and not isinstance(raw, bool) and raw > 0 else 0


class Tally(NamedTuple):
    """One writer's day. Every number only grows."""
    spent: int = 0      # items X billed
    held: int = 0       # items ever held for calls in flight
    returned: int = 0   # held items given back (settled or released)
    calls: int = 0      # paid calls

    def merge(self, other: "Tally") -> "Tally":
        return Tally(*(max(a, b) for a, b in zip(self, other)))

    @property
    def items(self) -> int:
        return self.spent + max(0, self.held - self.returned)


@dataclass(frozen=True)
class Tank:
    """One day of spending: a tally per writer. Replaced whole, never edited."""
    day: str
    tallies: dict = field(default_factory=dict)  # writer -> Tally

    def merge(self, other: Optional["Tank"]) -> "Tank":
        if other is None or other.day != self.day:
            return self
        writers = set(self.tallies) | set(other.tallies)
        return Tank(self.day, {w: self.tallies.get(w, Tally()).merge(other.tallies.get(w, Tally()))
                               for w in writers})

    def covers(self, other: "Tank") -> bool:
        """True when this copy already knows everything `other` knows."""
        return all(self.tallies.get(w, Tally()).merge(t) == self.tallies.get(w, Tally())
                   for w, t in other.tallies.items())

    def bump(self, writer: str, **more: int) -> "Tank":
        now = self.tallies.get(writer, Tally())
        return Tank(self.day, {**self.tallies, writer: now._replace(
            **{k: getattr(now, k) + v for k, v in more.items()})})

    def ledger(self, price: float) -> Ledger:
        tallies = self.tallies.values()
        return Ledger(day=self.day, counted=sum(t.items for t in tallies),
                      calls=sum(t.calls for t in tallies), price=price)

    def to_json(self) -> dict:
        led = self.ledger(PRICE_PER_SPACE)
        # "paid_ids" and a numeric "calls" keep the previous version counting during a deploy.
        return {"tallies": {w: list(t) for w, t in sorted(self.tallies.items())},
                "paid_ids": [f"n{i}" for i in range(led.items)], "calls": led.calls}

    @classmethod
    def from_json(cls, day: str, raw) -> Optional["Tank"]:
        if not isinstance(raw, dict):
            return None
        tallies = raw.get("tallies")
        if isinstance(tallies, dict):
            return cls(day, {str(w): Tally(*(_count(n) for n in t[:4]))
                             for w, t in tallies.items() if isinstance(t, list)})
        if isinstance(raw.get("paid_ids"), list):  # written by the previous version: one fixed tally
            return cls(day, {"legacy": Tally(spent=len(raw["paid_ids"]), calls=_count(raw.get("calls")))})
        return None


class SharedBudget(Budget):
    """A Budget whose tank lives in the shared store. If the store is unreachable it keeps
    counting in memory and grants no new fuel until it can read the tank again."""

    def __init__(self, name: str, store: StoreGetter, daily_cap: float, clock=utc_day,
                 price: float = PRICE_PER_SPACE, pause: Pause = time.sleep):
        self._name = name
        self._shared = store
        self._pause = pause
        self._writer = mint("tank-")      # this budget's own tally; nobody else writes it
        self._given_back = frozenset()    # holds already returned, so returning one twice counts once
        super().__init__(path=None, daily_cap=daily_cap, clock=clock, price=price)

    def ledger(self) -> Ledger:
        with self._lock:
            return self._look()[0].ledger(self._price)

    def try_reserve(self, count: int, tag: str = "") -> Optional[frozenset]:
        keys = hold_keys(count, tag)
        with self._lock:
            tank, readable = self._look()
            if not readable or not self._fits(tank.ledger(self._price), len(keys)):
                return None
            self._tank = tank.bump(self._writer, held=len(keys))
            self._publish()
        self._pause(RECHECK_SECONDS)  # announced; now give a racing instance's hold time to land
        with self._lock:
            tank, readable = self._look()
            if readable and tank.ledger(self._price).spent <= self._cap + 1e-9:
                return keys
            self._tank = self._give_back(tank, keys)
            if readable:
                self._publish()
            return None

    def charge(self, space_ids) -> Ledger:
        return self._change(lambda tank: tank.bump(self._writer, spent=len(frozenset(space_ids)), calls=1))

    def settle(self, held, billed) -> Ledger:
        return self._change(lambda tank: self._give_back(tank, held).bump(
            self._writer, spent=len(frozenset(billed)), calls=1))

    def release(self, held) -> Ledger:
        return self._change(lambda tank: self._give_back(tank, held), recheck=False)

    def _change(self, step: Callable[[Tank], Tank], recheck: bool = True) -> Ledger:
        with self._lock:
            tank, readable = self._look()
            self._tank = step(tank)  # counted in memory either way
            if readable:
                self._publish()
            led = self._tank.ledger(self._price)
        if readable and recheck:  # a write that covered this one up in the meantime gets undone
            self._pause(RECHECK_SECONDS)
            with self._lock:
                self._look()
        return led

    def _give_back(self, tank: Tank, held) -> Tank:
        fresh = frozenset(held) - self._given_back
        self._given_back = self._given_back | fresh
        return tank.bump(self._writer, returned=len(fresh))

    # ---- the store (called with self._lock held) ------------------------------------------------
    def _key(self, day: str) -> str:
        return f"fuel-{self._name}-{day}"

    def _look(self) -> tuple[Tank, bool]:
        """Today's tank, what we know merged with what the store holds, and whether the store
        could be read. If it was read and lacks something we know, put that back."""
        today = self._clock()
        mine = self._tank if self._tank.day == today else Tank(today)
        readable, stored = self._read(today)
        self._tank = mine.merge(stored)
        if readable and not (stored or Tank(today)).covers(self._tank):
            self._publish()
        return self._tank, readable

    def _publish(self) -> None:
        """Write our tank and read it back; if another write landed on ours, merge and try again."""
        for _ in range(PUBLISH_TRIES):
            if not self._write(self._tank):
                return  # counted in memory; the next write carries it
            readable, stored = self._read(self._tank.day)
            if not readable or (stored is not None and stored.covers(self._tank)):
                return
            self._tank = self._tank.merge(stored)
        _warn(f"write {self._name}", RuntimeError(f"covered up {PUBLISH_TRIES} times in a row"))

    def _read(self, day: str) -> tuple[bool, Optional[Tank]]:
        """(could the store be read, the tank it holds or None)."""
        try:
            store = self._shared()
            if store is None:
                return False, None
            return True, Tank.from_json(day, store.get(self._key(day)))
        except Exception as err:
            _warn(f"read {self._name}", err)
            return False, None

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
        self._tank = Tank(today).merge(self._read(today)[1])
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
        self._me = mint("radio-")  # this instance's leases start with this

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
        lease = mint(f"{self._me}/")
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
            gone = self._holder(word) is None  # asked first: a holder shelves its answer, then lets go
            fresh = self.fresh(word)
            if fresh is not None or gone:
                return fresh
        return None

    def fresh(self, word: str) -> Optional[list[Space]]:
        """This word's rooms if someone bought them within the hour, else None."""
        shelf = self.get(word)
        return shelf[1] if shelf and shelf[0] < FRESH_SECONDS else None

    def _holder(self, word: str) -> Optional[str]:
        """Who holds this word's lease: None (nobody), "mine" (this instance) or "other"."""
        raw = self._get(self._key(word, "lease"), "lease read")
        if not isinstance(raw, dict) or not isinstance(raw.get("until"), (int, float)):
            return None
        if raw["until"] <= self._now():
            return None
        return "mine" if str(raw.get("owner", "")).startswith(f"{self._me}/") else "other"

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
