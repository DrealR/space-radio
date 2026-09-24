"""People aboard a Space, as the radio shows them: checked, cleaned, never trusted raw.

Every field comes from X's JSON and ends up on someone's screen, so names lose
control and bidi-override characters, handles must look like handles, and
avatars must be X's own images over https. Nothing here is stored; avatars
are hotlinked from X and each person links to their X profile.
"""
from __future__ import annotations

import re
import unicodedata
from dataclasses import asdict, dataclass
from typing import Optional
from urllib.parse import urlsplit

USERNAME = re.compile(r"^[A-Za-z0-9_]{1,15}$")
USER_ID = re.compile(r"^[0-9]{1,20}$")
AVATAR_HOSTS = frozenset({"pbs.twimg.com", "abs.twimg.com"})
ROLES = ("host", "cohost", "speaker")
NAME_LIMIT = 50
VERIFIED_KINDS = ("blue", "business", "government")

# Bidi embeddings, overrides and isolates (U+202A-202E, U+2066-2069) can flip the text around a name.
_BIDI = frozenset(chr(c) for c in (*range(0x202A, 0x202F), *range(0x2066, 0x206A)))
_AVATAR_PATH = re.compile(r"/[A-Za-z0-9._~/%-]{1,400}")
_SIZE = re.compile(r"_normal(\.(?:jpe?g|png|gif|webp))$", re.IGNORECASE)


@dataclass(frozen=True)
class Person:
    id: str
    role: str                # host | cohost | speaker
    name: str
    username: str
    avatar: str = ""         # _200x200 from X's CDN, or "" (the client draws initials)
    avatar_small: str = ""   # the original _normal image, the client's fallback
    verified: str = ""       # "" | blue | business | government
    protected: bool = False

    @property
    def profile_url(self) -> str:
        return f"https://x.com/{self.username}"

    def to_json(self) -> dict:
        return {**asdict(self), "profile_url": self.profile_url}


def normalize_person(raw, role: str) -> Optional[Person]:
    """One of X's user objects -> Person, or None when the id or handle is unusable."""
    if not isinstance(raw, dict) or role not in ROLES:
        return None
    uid = user_id(raw.get("id"))
    username = raw.get("username")
    if not uid or not isinstance(username, str) or not USERNAME.fullmatch(username):
        return None
    small = clean_avatar(raw.get("profile_image_url"))
    return Person(
        id=uid, role=role, username=username,
        name=clean_text(raw.get("name"), NAME_LIMIT) or f"@{username}",
        avatar=_SIZE.sub(r"_200x200\1", small), avatar_small=small,
        verified=verified_kind(raw), protected=raw.get("protected") is True,
    )


def user_id(raw) -> Optional[str]:
    if isinstance(raw, bool) or not isinstance(raw, (str, int)):
        return None
    text = str(raw)
    return text if USER_ID.fullmatch(text) else None


def clean_text(raw, limit: int) -> str:
    """Printable, single-spaced, at most `limit` code points. RTL scripts and emoji stay.
    Text with nothing visible in it (only zero-width characters) counts as empty."""
    if not isinstance(raw, str):
        return ""
    spaced = "".join(" " if ch.isspace() else ch for ch in raw[: limit * 4] if ch.isspace() or _kept(ch))
    text = " ".join(spaced.split())[:limit].rstrip()
    return text if any(_visible(ch) for ch in text) else ""


def _kept(ch: str) -> bool:
    return ch not in _BIDI and unicodedata.category(ch) not in ("Cc", "Cs")


def _visible(ch: str) -> bool:
    # Letters, marks, numbers, punctuation, symbols (emoji are symbols); not spaces or format characters.
    return unicodedata.category(ch)[0] in "LMNPS"


def clean_avatar(raw) -> str:
    """X's own image over https, rebuilt from its parts; "" for anything else."""
    if not isinstance(raw, str) or len(raw) > 512:
        return ""
    try:
        parts = urlsplit(raw)
    except ValueError:
        return ""
    # netloc must be exactly an X image host: this also rules out ports and user:pass@.
    ok = (parts.scheme == "https" and parts.netloc in AVATAR_HOSTS and not parts.query
          and not parts.fragment and _AVATAR_PATH.fullmatch(parts.path))
    return f"https://{parts.netloc}{parts.path}" if ok else ""


def verified_kind(raw: dict) -> str:
    kind = raw.get("verified_type")
    if kind in VERIFIED_KINDS:
        return kind
    return "blue" if raw.get("verified") is True else ""
