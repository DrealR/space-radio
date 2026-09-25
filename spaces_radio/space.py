"""A live room of real voices, and how to recognize one from a link."""
from __future__ import annotations

import re
from dataclasses import dataclass, replace

# Space ids are short alphanumeric tokens, e.g. 1YqKDqWqdPLxV.
_ID = re.compile(r"^[A-Za-z0-9]{8,20}$")
_URL = re.compile(r"(?:x|twitter)\.com/i/spaces/([A-Za-z0-9]{8,20})")
_DIGITS = re.compile(r"[0-9]{1,12}")
_USER_ID = re.compile(r"[0-9]{1,20}")
MAX_HOST_IDS = 10


@dataclass(frozen=True)
class Space:
    id: str
    title: str
    listeners: int = 0
    speakers: int = 0
    hosts: int = 0
    started_at: str = ""
    lang: str = ""
    topic: str = ""
    source: str = ""  # "x-api" or "yours" (pasted in the browser)
    live: bool = True
    # X user ids of the hosts, as the search already returns them (no user lookup, no extra
    # cost). The browser matches them against the hosts a listener starred.
    host_ids: tuple = ()

    @property
    def url(self) -> str:
        return f"https://x.com/i/spaces/{self.id}"

    def tagged(self, topic: str) -> "Space":
        return replace(self, topic=topic)

    def to_json(self) -> dict:
        return {
            "id": self.id, "title": self.title, "listeners": self.listeners,
            "speakers": self.speakers, "hosts": self.hosts,
            "started_at": self.started_at, "lang": self.lang, "topic": self.topic,
            "source": self.source, "live": self.live, "url": self.url,
            "host_ids": list(self.host_ids),
        }


def parse_space_id(text: str) -> str | None:
    """Accept a Space link (x.com or twitter.com) or a bare id; None if neither."""
    text = (text or "").strip()
    match = _URL.search(text)
    if match:
        return match.group(1)
    return text if _ID.match(text) else None


def non_negative_int(raw) -> int:
    """A count from outside (X's JSON): a whole number, never negative; anything else is 0."""
    if isinstance(raw, bool):
        return 0
    if isinstance(raw, int):
        return max(0, raw)
    if isinstance(raw, float) and raw.is_integer():
        return max(0, int(raw))
    if isinstance(raw, str) and _DIGITS.fullmatch(raw):
        return int(raw)
    return 0


def host_id_list(raw) -> tuple:
    """X's host_ids -> unique numeric ids in X's order, at most ten; junk is dropped."""
    if not isinstance(raw, list):
        return ()
    ids = [str(i) for i in raw if isinstance(i, (str, int)) and not isinstance(i, bool)]
    valid = [i for i in ids if _USER_ID.fullmatch(i)]
    return tuple(dict.fromkeys(valid))[:MAX_HOST_IDS]
