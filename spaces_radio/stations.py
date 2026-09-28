"""Stations on the dial. Each station is a few words X matches against Space titles.
Every word is one search, shared for an hour, and every room it returns is billed
(about $0.05 per word). So each band keeps to its two best words from the live data,
and tunes them at the same time, paying for both either way.
Tuned Sep 24 against live data: "music"/"guitar" and "NFL"/"NBA" alone came back nearly empty."""
from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor

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
    """A band's words are searched at the same time, so tuning waits for the slower one, not
    for both in turn. The merge is the one a listener already sees, in word order: the first
    word's room for an id wins, problems keep word order, and the busiest rooms come first."""
    if station not in STATIONS:
        raise KeyError(station)
    words = STATIONS[station]
    with ThreadPoolExecutor(max_workers=len(words)) as pool:
        answers = list(pool.map(lambda word: gather(sources, word), words))
    rooms: dict[str, Space] = {}
    problems: list[str] = []
    for found, errs in answers:
        for space in found:
            rooms.setdefault(space.id, space.tagged(station))
        problems.extend(e for e in errs if e not in problems)
    ordered = sorted(rooms.values(), key=lambda s: -s.listeners)
    return ordered, problems
