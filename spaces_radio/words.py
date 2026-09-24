"""Search words for bands people make themselves.

One word (or short phrase) per request, in one canonical spelling, so the CDN
keeps a single shared answer per word and nobody can mint endless cache keys.
Characters are limited to ones that JavaScript's encodeURIComponent and
Python's quote(safe="") encode identically, so the page and the server agree
on that spelling.
"""
from __future__ import annotations

import re
from urllib.parse import quote, unquote

MAX_WORD = 30
_ALLOWED = re.compile(r"[a-z0-9#$\- ]{2,%d}" % MAX_WORD)
_HAS_ALNUM = re.compile(r"[a-z0-9]")


def normalize_word(text) -> str | None:
    """Lowercase, trim, single spaces. None if it can't be a search word."""
    word = " ".join(str(text or "").lower().split())
    if not _ALLOWED.fullmatch(word) or not _HAS_ALNUM.search(word):
        return None
    return word


def canonical_query(word: str) -> str:
    """The one query string the page sends for a word: q=<encodeURIComponent(word)>."""
    return "q=" + quote(word, safe="")


def word_from_raw(raw_query: str) -> str | None:
    """The word behind a raw query string, only if it is already in canonical form."""
    if not raw_query.startswith("q="):
        return None
    word = normalize_word(unquote(raw_query[2:]))
    return word if word and canonical_query(word) == raw_query else None
