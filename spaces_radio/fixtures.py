"""Fake X for local work: no key, no network, no cost.

    SPACES_RADIO_FAKE=1 python3 -m spaces_radio.server

The answers below run through the real parsing, budget and cache code, so
every state of the dial and the crew manifest can be seen for free. They are
shaped like X's documented samples, with a few traps the parser must catch.
Ignored whenever VERCEL is set. Ids to try:

    1FakeRoomAaaa ... 1FakeRoomFfff   live rooms, one fixed crew
    0000000ended                      the room ended (X's not-found answer)
    0000000limit                      X is busy (HTTP 429)
"""
from __future__ import annotations

import time
import urllib.error
from datetime import datetime, timedelta, timezone
from typing import Callable, Optional
from urllib.parse import parse_qs, urlsplit

ENDED_ID = "0000000ended"
LIMIT_ID = "0000000limit"
NOT_FOUND = "https://api.twitter.com/2/problems/resource-not-found"
DEFAULT_AVATAR = "https://abs.twimg.com/sticky/default_profile_images/default_profile_normal.png"

# Nine users as X would return them. Usernames start with sr26_ so they are plainly not real people.
# Traps: 1000000004's avatar is off X (blanked), 1000000005's name hides a bidi override and a bell,
# 1000000007's name runs past 50 characters, 1000000008's handle is invalid (dropped).
_USERS = (
    {"id": "1000000001", "name": "Captain Nova", "username": "sr26_captain",
     "profile_image_url": DEFAULT_AVATAR, "verified": False, "protected": False},
    {"id": "1000000002", "name": "Orbit Ops", "username": "sr26_orbit",
     "verified": True, "verified_type": "business", "protected": False},
    {"id": "1000000003", "name": "نور الفضاء", "username": "sr26_noor",
     "profile_image_url": DEFAULT_AVATAR, "verified": False, "protected": False},
    {"id": "1000000004", "name": "DJ 🎧 Nebula", "username": "sr26_nebula",
     "profile_image_url": "https://example.com/avatars/nebula_normal.png", "verified": False},
    {"id": "1000000005", "name": "Quiet\u202e Comet\u0007", "username": "sr26_comet",
     "verified": False, "protected": True},
    {"id": "1000000006", "name": "Lunar  Lou", "username": "sr26_lunar",
     "profile_image_url": DEFAULT_AVATAR, "verified": True},
    {"id": "1000000007", "name": "A display name that keeps on going well past fifty characters",
     "username": "sr26_longname", "verified": False},
    {"id": "1000000008", "name": "Bad Handle", "username": "not a handle!", "verified": False},
    {"id": "1000000009", "name": "Static Sam", "username": "sr26_static",
     "profile_image_url": DEFAULT_AVATAR, "verified": False},
)
CREATOR = "1000000001"
HOST_IDS = ("1000000001", "1000000002", "1000000003")          # the creator is also listed as a host
SPEAKER_IDS = ("1000000003", "1000000004", "1000000005", "1000000006",
               "1000000007", "1000000008", "1000000009")        # a co-host on the mic is listed too

# id, title, people in the room, minutes on air
_ROOMS = (
    ("1FakeRoomAaaa", "Late night lo-fi and chill talk", 214, 18),
    ("1FakeRoomBbbb", "AI builders: what shipped this week", 96, 42),
    ("1FakeRoomCccc", "Sunday prayer circle 🙏", 57, 75),
    ("1FakeRoomDddd", "Open mic: bring your bars", 331, 9),
    ("1FakeRoomEeee", "Crypto morning coffee", 12, 110),
    ("1FakeRoomFfff", "Stand-up night: tell us your worst joke", 148, 64),
)


def _stamp(now: datetime, minutes: int) -> str:
    return (now - timedelta(minutes=minutes)).strftime("%Y-%m-%dT%H:%M:%S.000Z")


def search_body(now: Optional[datetime] = None) -> dict:
    """GET /2/spaces/search: six live rooms, each started within the last two hours."""
    now = now or datetime.now(timezone.utc)
    rooms = [{"id": rid, "state": "live", "title": title, "participant_count": people,
              "started_at": _stamp(now, minutes), "lang": "en", "is_ticketed": False,
              "host_ids": list(HOST_IDS[: 1 + i % 3]), "speaker_ids": list(SPEAKER_IDS[1: 3 + i])}
             for i, (rid, title, people, minutes) in enumerate(_ROOMS)]
    return {"data": rooms, "meta": {"result_count": len(rooms)}}


FULL = "creator_id,host_ids,speaker_ids"


def crew_body(space_id: str, now: Optional[datetime] = None, expansions: str = FULL) -> dict:
    """GET /2/spaces/<id>: the fixed crew, aboard whichever room was asked for. Like X, it
    names only the people the expansions ask for: nobody, the creator, or everyone."""
    now = now or datetime.now(timezone.utc)
    known = {rid: (title, people, minutes) for rid, title, people, minutes in _ROOMS}
    title, people, minutes = known.get(space_id, ("The crew test ship", 214, 30))
    data = {"id": space_id, "state": "live", "title": title, "participant_count": people,
            "started_at": _stamp(now, minutes), "lang": "en", "is_ticketed": False,
            "creator_id": CREATOR, "host_ids": list(HOST_IDS), "speaker_ids": list(SPEAKER_IDS)}
    wanted = set(expansions.split(",")) - {""}
    if not wanted:
        return {"data": data}
    named = [dict(u) for u in _USERS if wanted != {"creator_id"} or u["id"] == CREATOR]
    return {"data": data, "includes": {"users": named}}


def fake_fetch(url: str, token: str) -> dict:
    """Stands in for sources._http_get_json: same call, canned answers."""
    path = urlsplit(url).path
    if path == "/2/spaces/search":
        return search_body()
    if not path.startswith("/2/spaces/"):
        raise ValueError(f"fake X has no answer for {path}")
    space_id = path.rsplit("/", 1)[-1]
    if space_id == ENDED_ID:
        return {"errors": [{"type": NOT_FOUND, "title": "Not Found Error", "resource_id": space_id}]}
    if space_id == LIMIT_ID:
        raise urllib.error.HTTPError(url, 429, "Too Many Requests", {}, None)
    return crew_body(space_id, expansions=parse_qs(urlsplit(url).query).get("expansions", [""])[0])


def make_fake_fetch(crew_delay: float = 0.0,
                    sleep: Callable[[float], None] = time.sleep) -> Callable[[str, str], dict]:
    """fake_fetch, with crew lookups held back a moment so the SCANNING CREW state can be seen."""
    def fetch(url: str, token: str) -> dict:
        if crew_delay > 0 and urlsplit(url).path != "/2/spaces/search":
            sleep(crew_delay)
        return fake_fetch(url, token)
    return fetch
