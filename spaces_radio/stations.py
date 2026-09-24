"""Stations on the dial. Each station is a few words X matches against Space titles.
Every word is one paid search (cached 10 minutes), so stations stay short."""
from __future__ import annotations

from .sources import SpaceSource, gather
from .space import Space

STATIONS: dict[str, tuple[str, ...]] = {
    "anything": ("chill", "talk", "vibes"),
    "music": ("music", "guitar"),
    "tech": ("tech", "AI"),
    "faith": ("faith", "prayer"),
    "news": ("news", "politics"),
    "sports": ("NFL", "NBA"),
    "money": ("business", "crypto"),
    "laughs": ("comedy", "funny"),
    "gaming": ("gaming",),
    "late night": ("late night", "cant sleep"),
}


def tune(station: str, sources: list[SpaceSource]) -> tuple[list[Space], list[str]]:
    if station not in STATIONS:
        raise KeyError(station)
    rooms: dict[str, Space] = {}
    problems: list[str] = []
    for word in STATIONS[station]:
        found, errs = gather(sources, word)
        for space in found:
            rooms.setdefault(space.id, space if space.source == "saved" else space.tagged(station))
        problems.extend(e for e in errs if e not in problems)
    ordered = sorted(rooms.values(), key=lambda s: (not s.live, -s.listeners))
    return ordered, problems
