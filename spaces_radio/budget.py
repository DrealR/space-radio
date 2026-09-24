"""A daily spending guard for the X API.

X bills $0.005 per Space returned and counts each Space once per UTC day.
The ledger remembers which ids were already paid for today, refuses a call
whose worst case would pass the cap, and survives restarts in a small JSON file.
"""
from __future__ import annotations

import json
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path

PRICE_PER_SPACE = 0.005
DEFAULT_DAILY_CAP = 0.50  # dollars; ~100 distinct Spaces a day


def utc_day(now: datetime | None = None) -> str:
    return (now or datetime.now(timezone.utc)).strftime("%Y-%m-%d")


@dataclass(frozen=True)
class Ledger:
    day: str
    paid_ids: frozenset = field(default_factory=frozenset)
    calls: int = 0

    @property
    def spent(self) -> float:
        return round(len(self.paid_ids) * PRICE_PER_SPACE, 4)


class Budget:
    def __init__(self, path: Path, daily_cap: float = DEFAULT_DAILY_CAP, clock=utc_day):
        self._path = path
        self._cap = daily_cap
        self._clock = clock
        self._ledger = self._load()

    @property
    def cap(self) -> float:
        return self._cap

    def ledger(self) -> Ledger:
        today = self._clock()
        if self._ledger.day != today:
            self._ledger = Ledger(day=today)
        return self._ledger

    def can_afford(self, max_results: int) -> bool:
        worst = self.ledger().spent + max_results * PRICE_PER_SPACE
        return worst <= self._cap + 1e-9

    def charge(self, space_ids) -> Ledger:
        current = self.ledger()
        self._ledger = Ledger(
            day=current.day,
            paid_ids=current.paid_ids | frozenset(space_ids),
            calls=current.calls + 1,
        )
        self._save()
        return self._ledger

    def status(self) -> dict:
        led = self.ledger()
        return {"day": led.day, "spent": led.spent, "cap": self._cap,
                "calls": led.calls, "spaces_paid": len(led.paid_ids)}

    def _load(self) -> Ledger:
        try:
            raw = json.loads(self._path.read_text())
            return Ledger(day=raw["day"], paid_ids=frozenset(raw["paid_ids"]), calls=int(raw["calls"]))
        except FileNotFoundError:
            return Ledger(day=self._clock())
        except (ValueError, KeyError, TypeError) as err:
            # A damaged ledger must not reset spend to zero silently: assume today is used up.
            print(f"[spaces-radio] budget ledger unreadable ({err}); treating today as spent")
            return Ledger(day=self._clock(), paid_ids=frozenset(
                f"unknown-{i}" for i in range(int(self._cap / PRICE_PER_SPACE) + 1)))

    def _save(self) -> None:
        self._path.parent.mkdir(parents=True, exist_ok=True)
        led = self._ledger
        self._path.write_text(json.dumps(
            {"day": led.day, "paid_ids": sorted(led.paid_ids), "calls": led.calls}, indent=1))
