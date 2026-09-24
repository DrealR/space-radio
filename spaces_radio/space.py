"""A live room of real voices, and how to recognize one from a link."""
from __future__ import annotations

import re
from dataclasses import dataclass, replace

# Space ids are short alphanumeric tokens, e.g. 1YqKDqWqdPLxV.
_ID = re.compile(r"^[A-Za-z0-9]{8,20}$")
_URL = re.compile(r"(?:x|twitter)\.com/i/spaces/([A-Za-z0-9]{8,20})")


@dataclass(frozen=True)
class Space:
    id: str
    title: str
    listeners: int = 0
    started_at: str = ""
    lang: str = ""
    topic: str = ""
    source: str = ""  # "x-api" or "saved"
    live: bool = True

    @property
    def url(self) -> str:
        return f"https://x.com/i/spaces/{self.id}"

    def tagged(self, topic: str) -> "Space":
        return replace(self, topic=topic)

    def to_json(self) -> dict:
        return {
            "id": self.id, "title": self.title, "listeners": self.listeners,
            "started_at": self.started_at, "lang": self.lang, "topic": self.topic,
            "source": self.source, "live": self.live, "url": self.url,
        }


def parse_space_id(text: str) -> str | None:
    """Accept a Space link (x.com or twitter.com) or a bare id; None if neither."""
    text = (text or "").strip()
    match = _URL.search(text)
    if match:
        return match.group(1)
    return text if _ID.match(text) else None
