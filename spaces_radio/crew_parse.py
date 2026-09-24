"""Who is aboard a Space, pure half: X's lookup JSON in, a validated CrewScan out.

No network, no clock, no budget. crew.py does the paid I/O around these.
X shares how many people are listening, never who, so listeners stay a count.
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Optional
from urllib.parse import urlencode

from .people import normalize_person, user_id, clean_text
from .space import non_negative_int

LOOKUP_URL = "https://api.x.com/2/spaces/{id}"
CREW_ID = re.compile(r"^[A-Za-z0-9]{8,13}$")
MAX_CREW = 30
MAX_BILLABLE = 1000         # never walk an unbounded id list, even to count what X would bill

SPACE_FIELDS = "creator_id,host_ids,speaker_ids,title,state,participant_count,started_at,lang,is_ticketed"
USER_FIELDS = "name,username,profile_image_url,verified,verified_type,protected"
# probe: the Space alone ($0.005, once a day) with its plain id lists, and no names (no user charge).
EXPANSIONS = {"full": "creator_id,host_ids,speaker_ids", "host-only": "creator_id", "probe": ""}

MESSAGES = {
    "bad-request": "Only ?id= is accepted.",
    "bad-id": "That isn't a Space id.",
    "no-key": "This radio has no X key, so it can't look up names. X's own page shows everyone.",
    "budget": "The crew scanner is resting until midnight UTC. X's own page shows everyone.",
    "credits": "X says this radio is out of credits. X's own page shows everyone.",
    "rate": "X is busy right now. Try again in a minute.",
    "auth": "X refused this radio's key.",
    "offline": "Couldn't reach X.",
    "upstream": "X sent an answer the radio couldn't read.",
}
_STATES = {"live": "live", "scheduled": "scheduled", "ended": "ended", "canceled": "ended"}
_ISO = re.compile(r"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}(?::[0-9]{2}(?:\.[0-9]{1,6})?)?"
                  r"(?:Z|[+-][0-9]{2}:?[0-9]{2})?")
_LANG = re.compile(r"[A-Za-z0-9-]{1,16}")


class CrewError(Exception):
    """A crew scan failed. `reason` is one of the /api/crew contract reasons;
    `message` is the sentence a listener sees; `detail` is for the server log only."""

    def __init__(self, reason: str, detail: str = ""):
        self.reason = reason if reason in MESSAGES else "upstream"
        self.message = MESSAGES[self.reason]
        self.detail = detail
        super().__init__(f"{self.reason} ({detail})" if detail else self.reason)


@dataclass(frozen=True)
class CrewScan:
    id: str
    state: str                  # live | ended | scheduled
    title: str = "Untitled room"
    listeners: int = 0
    started_at: str = ""
    lang: str = ""
    crew: tuple = ()            # Person, ordered host, co-hosts, speakers
    hosts: int = 0              # counted from X's id lists, so right even in host-only mode
    speakers: int = 0
    mode: str = "full"          # full | host-only
    fetched_at: str = ""        # ISO UTC, set by CrewLookup

    @property
    def url(self) -> str:
        return f"https://x.com/i/spaces/{self.id}"

    @property
    def others(self) -> int:
        return max(0, self.listeners - self.hosts - self.speakers)

    def to_json(self) -> dict:
        return {
            "id": self.id, "state": self.state, "title": self.title, "listeners": self.listeners,
            "started_at": self.started_at, "lang": self.lang, "url": self.url,
            "crew": [p.to_json() for p in self.crew],
            "counts": {"hosts": self.hosts, "speakers": self.speakers}, "others": self.others,
        }


def valid_crew_id(raw) -> Optional[str]:
    """The bare id or None. Links are refused: the client sends ids, so the cache has one key per room."""
    return raw if isinstance(raw, str) and CREW_ID.fullmatch(raw) else None


def crew_url(space_id: str, mode: str) -> str:
    if not valid_crew_id(space_id) or mode not in EXPANSIONS:
        raise ValueError("crew_url needs a bare Space id and a known mode")
    params = {"space.fields": SPACE_FIELDS}
    if EXPANSIONS[mode]:
        params = {**params, "expansions": EXPANSIONS[mode], "user.fields": USER_FIELDS}
    return f"{LOOKUP_URL.format(id=space_id)}?{urlencode(params, safe=',')}"


def parse_crew(body, space_id: str, mode: str) -> CrewScan:
    """X's lookup answer -> CrewScan. Raises CrewError("upstream") for anything unreadable."""
    if not isinstance(body, dict):
        raise CrewError("upstream", "answer is not an object")
    data = body.get("data")
    if data is None and isinstance(body.get("errors"), list) and body["errors"]:
        return CrewScan(id=space_id, state="ended", mode=mode)  # X says: no such Space (any more)
    if not isinstance(data, dict) or data.get("id") != space_id:
        raise CrewError("upstream", "no Space data for this id")
    raw_state = data.get("state")
    state = _STATES.get(raw_state) if isinstance(raw_state, str) else None
    if state is None:
        raise CrewError("upstream", "unknown Space state")
    return _scan(data, _users_by_id(body), space_id, state, mode)


def crew_ids(body) -> frozenset:
    """Every user id a full lookup would expand, and X would bill, read from the plain id lists."""
    data = body.get("data") if isinstance(body, dict) else None
    if not isinstance(data, dict):
        return frozenset()
    lists = ([data.get("creator_id")], data.get("host_ids"), data.get("speaker_ids"))
    ids = (user_id(item) for raw in lists if isinstance(raw, list) for item in raw[:MAX_BILLABLE])
    return frozenset(i for i in ids if i)


def billed_ids(body, space_id: str) -> tuple:
    """One ledger key per user X returned, valid or not: X bills them all, once a day each."""
    return tuple(_billed_id(u, space_id, i) for i, u in enumerate(_included_users(body)))


def _billed_id(raw_user, sid: str, index: int) -> str:
    raw = raw_user.get("id") if isinstance(raw_user, dict) else None
    text = str(raw)[:32] if isinstance(raw, (str, int)) and not isinstance(raw, bool) else ""
    return text or f"noid-{sid}-{index}"


def _scan(data: dict, users: dict, space_id: str, state: str, mode: str) -> CrewScan:
    creator = user_id(data.get("creator_id"))
    host_ids = _id_list(data.get("host_ids"))
    speaker_ids = _id_list(data.get("speaker_ids"))
    roles = _roles(creator, host_ids, speaker_ids) if state == "live" else ()
    if mode == "host-only":
        roles = roles[:1]
    people = (normalize_person(users.get(uid), role) for uid, role in roles)
    everyone_hosting = frozenset(host_ids) | frozenset(filter(None, [creator]))
    return CrewScan(
        id=space_id, state=state,
        title=clean_title(data.get("title")),
        listeners=0 if state == "ended" else non_negative_int(data.get("participant_count")),
        started_at=_match(_ISO, data.get("started_at")),
        lang=_match(_LANG, data.get("lang")),
        crew=tuple(p for p in people if p)[:MAX_CREW],
        hosts=len(everyone_hosting),
        speakers=len(frozenset(speaker_ids) - everyone_hosting),
        mode=mode,
    )


def _roles(creator: Optional[str], host_ids: tuple, speaker_ids: tuple) -> tuple:
    """(user id, role) in display order, each person once, in their highest role."""
    host = creator or (host_ids[0] if host_ids else None)
    cohosts = tuple(i for i in host_ids if i != host)
    speakers = tuple(i for i in speaker_ids if i not in host_ids and i != host)
    lead = ((host, "host"),) if host else ()
    return lead + tuple((i, "cohost") for i in cohosts) + tuple((i, "speaker") for i in speakers)


def _id_list(raw) -> tuple:
    """Valid user ids from one of X's id lists, unique, in X's order."""
    if not isinstance(raw, list):
        return ()
    ids = (user_id(item) for item in raw[:100])
    return tuple(dict.fromkeys(i for i in ids if i))


def _users_by_id(body: dict) -> dict:
    users = _included_users(body)[:100]  # a crew is ~16 people; never parse an unbounded list
    pairs = ((user_id(u.get("id")), u) for u in users if isinstance(u, dict))
    return {uid: u for uid, u in pairs if uid}


def _included_users(body) -> list:
    includes = body.get("includes") if isinstance(body, dict) else None
    users = includes.get("users") if isinstance(includes, dict) else None
    return users if isinstance(users, list) else []


def clean_title(raw) -> str:
    return clean_text(raw, 200) or "Untitled room"


def _match(pattern: re.Pattern, raw) -> str:
    return raw if isinstance(raw, str) and pattern.fullmatch(raw) else ""
