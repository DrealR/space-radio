"""Stations on the dial. Each station is a few words X matches against Space titles.
Every word is one search, cached 10 minutes. X bills per room found, not per search,
so a wider net costs only for the extra rooms it catches.
Tuned Sep 24 against live data: "music"/"guitar" and "NFL"/"NBA" alone came back nearly empty."""
from __future__ import annotations

from .sources import SpaceSource, gather
from .space import Space

STATIONS: dict[str, tuple[str, ...]] = {
    "anything": ("chill", "talk", "vibes"),
    "music": ("music", "songs", "rap", "guitar"),
    "tech": ("tech", "AI", "startup"),
    "faith": ("God", "Jesus", "church", "prayer"),
    "news": ("news", "politics", "breaking"),
    "sports": ("sports", "football", "NFL", "NBA"),
    "money": ("business", "crypto", "trading"),
    "laughs": ("comedy", "funny", "jokes"),
    "gaming": ("gaming", "games", "gamers"),
    "late night": ("late night", "night", "cant sleep"),
}


def tune(station: str, sources: list[SpaceSource]) -> tuple[list[Space], list[str]]:
    if station not in STATIONS:
        raise KeyError(station)
    rooms: dict[str, Space] = {}
    problems: list[str] = []
    for word in STATIONS[station]:
        found, errs = gather(sources, word)
        for space in found:
            rooms.setdefault(space.id, space.tagged(station))
        problems.extend(e for e in errs if e not in problems)
    ordered = sorted(rooms.values(), key=lambda s: -s.listeners)
    return ordered, problems
