"""Sky Survey findings for the Space Radio server (order survey-server).

One test per finding, each named for what a listener notices, each decorated
@unittest.expectedFailure so the suite stays green: remove a decorator to watch
that one fail, then put it back. No network and no key: X, the shared relay and
the budgets are the same fakes the other suites use (tests/test_radio.py,
tests/test_fuel_races.py, tests/test_dock.py). Nothing here is fixed yet.
"""
import contextlib
import http.client
import io
import json
import tempfile
import threading
import unittest
import urllib.request
from http.server import ThreadingHTTPServer
from pathlib import Path

from spaces_radio.budget import PRICE_PER_SPACE, PRICE_PER_USER, Budget
from spaces_radio.crew import CrewLookup
from spaces_radio.crew_parse import clean_title
from spaces_radio.dock import MemoryStore
from spaces_radio.fuel import SharedAnswers, SharedBudget
from spaces_radio.server import make_handler
from spaces_radio.service import RadioService
from spaces_radio.space import Space
from spaces_radio.sources import XApiSource
from spaces_radio.ticket import Tickets
from tests.test_crew import SID, FakeCrewX, crew_body
from tests.test_radio import Clock, FakeX, TmpCase, x_item

DAY = "2026-09-24"
LONG_ID = "1YqKDqWqdPLxVabc"    # 16 characters: the dial takes it, /api/crew does not
NO_PAUSE = lambda seconds: None  # noqa: E731


def tank(store, cap=1.0):
    return SharedBudget("bands", lambda: store, daily_cap=cap, clock=lambda: DAY, pause=NO_PAUSE)


def answers(store, clock):
    return SharedAnswers(lambda: store, now=clock, pause=NO_PAUSE)


class TappedX:
    """X, standing in for a live key: records every call and answers with `items`."""

    def __init__(self, items=(), error=None):
        self.items, self.error, self.urls = list(items), error, []

    def __call__(self, url, token):
        self.urls.append(url)
        if self.error:
            raise self.error
        return {"data": self.items}


class DroppedX:
    """X, standing in for a live key, whose connection dies before the answer is whole."""

    def __init__(self, error):
        self.error = error

    def __call__(self, url, token):
        raise self.error


class XSearchCrashTests(TmpCase):
    """sources.py:206 catches URLError, TimeoutError and ValueError, but a connection that dies
    mid-answer raises OSError or http.client.HTTPException. crew.py maps both to "offline";
    the dial does not, so the exception runs past tune_raw/search_raw and the request dies."""

    def service(self, error):
        budget = Budget(self.dir / "b.json", clock=lambda: DAY)
        source = XApiSource("tok", budget, fetch=DroppedX(error))
        return RadioService(source, budget)

    def assert_answers_in_words(self, reply, word):
        self.assertIn(reply.status, (200, 502), f"a dead connection answered {reply.status}")
        if reply.status == 502:
            self.assertTrue(reply.body["error"])

    def test_a_band_when_x_drops_the_connection_answers_in_words(self):
        for error in (http.client.IncompleteRead(b'{"data": [{"id"', 40),
                    http.client.RemoteDisconnected("closed"),
                    ConnectionResetError(104, "Connection reset by peer")):
            with contextlib.redirect_stderr(io.StringIO()):
                self.assert_answers_in_words(self.service(error).tune_raw("station=music"), "music")

    def test_your_own_band_when_x_drops_the_connection_answers_in_words(self):
        with contextlib.redirect_stderr(io.StringIO()):
            self.assert_answers_in_words(self.service(ConnectionResetError(104, "reset")).search_raw("q=guitar"), "guitar")


class CrewCacheTests(TmpCase):
    """crew.py:112 serves any cached roster to any request, so a host-only scan cached by an
    unticketed request (a preset, a pasted link, a script) is handed to the listener who did get
    the room from the dial, ticket and all. The mode they were promised is the one they lose."""

    def service(self):
        self.spaces = Budget(self.dir / "s.json", daily_cap=1.0, clock=lambda: DAY)
        self.users = Budget(self.dir / "u.json", daily_cap=0.5, clock=lambda: DAY, price=PRICE_PER_USER)
        crew = CrewLookup("tok", self.spaces, self.users, fetch=FakeCrewX(crew_body()), log=lambda line: None)
        band = Budget(self.dir / "b.json", clock=lambda: DAY)
        source = XApiSource("tok", band, fetch=lambda url, token: {"data": [x_item(SID)]})
        return RadioService(source, band, crew, Tickets(b"k"))

    @unittest.expectedFailure
    def test_a_listener_who_got_the_room_from_the_dial_still_gets_the_whole_crew(self):
        with contextlib.redirect_stderr(io.StringIO()):
            svc = self.service()
            ticket = svc.tune_raw("station=music").body["data"][0]["ticket"]
            svc.crew_raw(f"id={SID}")                    # a preset or a pasted link, no ticket
            reply = svc.crew_raw(f"id={SID}&t={ticket}")  # the listener, with a valid ticket
        self.assertEqual(reply.status, 200)
        self.assertEqual(reply.body["meta"]["mode"], "full", "the roster was paid for host-only")
        self.assertEqual(len(reply.body["data"]["crew"]), 3)


class RoomTitleTests(TmpCase):
    """sources.py:236 hands X's room title straight to the dial. crew_parse.clean_title and
    dock._clean_text strip control characters and bidi overrides from the very same field; the
    band, which is the surface every listener reads, is the one that does not."""

    def test_a_room_title_cannot_flip_the_dial_round(self):
        budget = Budget(self.dir / "b.json", clock=lambda: DAY)
        raw = "Guitar hang \u202egypsum\u0007 99$"
        room = XApiSource("tok", budget, fetch=FakeX([x_item(SID, raw)])).live("guitar")[0]
        self.assertEqual(room.title, clean_title(raw))
        self.assertNotIn("\u202e", room.to_json()["title"])
        self.assertNotIn("\u0007", room.to_json()["title"])


class EmptyShelfTests(unittest.TestCase):
    """sources.py:191 shelves whatever a search found, so an answer with no rooms in it is kept
    as fresh for a whole hour: the band stays empty for every instance and every listener, and
    the radio never asks X again, long after X has something to say."""

    def instance(self, store, clock, fake):
        return XApiSource("tok", tank(store), fetch=fake, now=clock, answers=answers(store, clock))

    @unittest.expectedFailure
    def test_a_band_x_had_nothing_for_keeps_being_empty_for_the_next_hour(self):
        store, clock = MemoryStore(), Clock()
        blip = TappedX([x_item(SID, is_ticketed=True)])   # X has a bad minute: nothing to show
        self.assertEqual(self.instance(store, clock, blip).live("guitar"), [])
        clock.t += 300                                      # five minutes on, X is fine again
        healthy = TappedX([x_item("1OwxWzqXyLbJQ", "Guitar hang", 40)])
        self.assertEqual([r.id for r in self.instance(store, clock, healthy).live("guitar")],
                         ["1OwxWzqXyLbJQ"], msg="the empty answer was still fresh; X was never asked")
        self.assertEqual(len(healthy.urls), 1)


class JunkShelfTests(unittest.TestCase):
    """fuel.py:274 reads the shelf's age with a bare float(), while _holder two doors down checks
    that its own number really is one. A shelf entry that is not the shape this version writes
    takes the whole search down instead of falling back to the last rooms."""

    def test_a_junk_shelf_entry_shows_the_last_rooms_instead_of_breaking_the_band(self):
        store, clock = MemoryStore(), Clock()
        shelf = answers(store, clock)
        for junk in ({"rooms": [], "at": "soon"}, {"rooms": [], "at": None}, {"rooms": [], "at": [1]}):
            store.set(SharedAnswers._key("guitar"), junk, {"ttl": 60})
            source = XApiSource("tok", tank(store), fetch=TappedX([x_item(SID)]), now=clock, answers=shelf)
            reply = RadioService(source, tank(store)).search_raw("q=guitar")
            self.assertIn(reply.status, (200, 502), junk)


class LongIdTests(TmpCase):
    """space.py:8 accepts 8-20 characters for a room, so a longer id reaches the dial with a
    ticket. service.py:47 and crew_parse.CREW_ID stop at 13, so the crew button on that room
    answers 400 "Only ?id= is accepted." and the listener is told they spelled it wrong."""

    @unittest.expectedFailure
    def test_a_long_room_id_on_the_dial_can_still_be_scanned(self):
        self.spaces = Budget(self.dir / "s.json", daily_cap=1.0, clock=lambda: DAY)
        self.users = Budget(self.dir / "u.json", daily_cap=0.5, clock=lambda: DAY, price=PRICE_PER_USER)
        crew = CrewLookup("tok", self.spaces, self.users, fetch=FakeCrewX(crew_body(LONG_ID)),
                          log=lambda line: None)
        band = Budget(self.dir / "b.json", clock=lambda: DAY)
        source = XApiSource("tok", band, fetch=lambda url, token: {"data": [x_item(LONG_ID)]})
        with contextlib.redirect_stderr(io.StringIO()):
            room = RadioService(source, band, crew, Tickets(b"k")).tune_raw("station=music").body["data"][0]
            self.assertEqual(room["id"], LONG_ID)
            reply = RadioService(source, band, crew, Tickets(b"k")).crew_raw(f"id={room['id']}&t={room['ticket']}")
        self.assertEqual(reply.status, 200, reply.body.get("error"))
        self.assertEqual(reply.body["data"]["id"], LONG_ID)


class LocalServerTests(TmpCase):
    """server.py:53 reads Content-Length with a bare int(). api/dock.py wraps the same read and
    answers a JSON 400; the local server lets the ValueError out, so a malformed beat leaves the
    dev server printing a traceback and the caller with no response at all."""

    def setUp(self):
        super().setUp()
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), make_handler(RadioService(None, None)))
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)
        self.port = self.server.server_address[1]

    def beat_with(self, length):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        self.addCleanup(conn.close)
        conn.putrequest("POST", "/api/dock")
        conn.putheader("Content-Length", length)
        conn.endheaders()
        response = conn.getresponse()
        return response.status, json.loads(response.read())

    def test_a_malformed_beat_length_answers_json_instead_of_dropping_the_connection(self):
        with contextlib.redirect_stderr(io.StringIO()):
            status, body = self.beat_with("banana")
        self.assertEqual(status, 400)
        self.assertFalse(body["success"])
        self.assertIn("Content-Length", body["error"])


if __name__ == "__main__":
    unittest.main()
