"""Stations on the dial. Each station is a few words X matches against Space titles.
Every word is one search, cached 30 minutes, and every room it returns is billed
(about $0.05 per word). So each band keeps to its two best words from the live data.
Tuned Sep 24 against live data: "music"/"guitar" and "NFL"/"NBA" alone came back nearly empty."""
from __future__ import annotations

from .sources import SpaceSource, gather
from .space import Space

STATIONS: dict[str, tuple[str, ...]] = {
    "anything": ("chill", "talk"),
    "music": ("music", "rap"),
    "tech": ("tech", "AI"),
    "faith": ("God", "prayer"),
    "news": ("news", "politics"),
    "sports": ("sports", "football"),
    "money": ("crypto", "business"),
    "laughs": ("comedy", "funny"),
    "gaming": ("gaming", "games"),
    "late night": ("late night", "night"),
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
