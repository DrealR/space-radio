"""Bands you make: /api/search?q=<word>. No network: X is a fake that records its calls."""
import tempfile
import unittest
from pathlib import Path

from spaces_radio.budget import Budget
from spaces_radio.service import FRESH_SECONDS, TROUBLE_SECONDS, RadioService
from spaces_radio.sources import XApiSource
from spaces_radio.ticket import Tickets
from spaces_radio.words import canonical_query, normalize_word, word_from_raw
from tests.test_radio import FakeX, x_item

ID_A, ID_B = "1YqKDqWqdPLxV", "1OwxWzqXyLbJQ"


class WordTests(unittest.TestCase):
    def test_normalize(self):
        self.assertEqual(normalize_word("  Open   Mic "), "open mic")
        self.assertEqual(normalize_word("#NFL"), "#nfl")
        for bad in ("a", "", "---", "<b>", "café", "x" * 31, "hi!", None):
            self.assertIsNone(normalize_word(bad), bad)

    def test_only_the_canonical_spelling_is_accepted(self):
        self.assertEqual(canonical_query("open mic"), "q=open%20mic")
        self.assertEqual(word_from_raw("q=open%20mic"), "open mic")
        self.assertEqual(word_from_raw("q=%23nfl"), "#nfl")
        for other in ("q=open+mic", "q=Open%20Mic", "q=open%20mic&x=1", "x=1&q=guitar", "q=%67uitar",
                      "q=guitar&", "q=", "", "q=%3Cb%3E", "q=hi%21"):
            self.assertIsNone(word_from_raw(other), other)


class SearchServiceTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self._tmp.name)

    def tearDown(self):
        self._tmp.cleanup()

    def make(self, fake=None, tickets=None):
        budget = Budget(self.dir / "b.json")
        source = XApiSource("tok", budget, fetch=fake) if fake else None
        return RadioService(source, budget, tickets=tickets)

    def test_word_search_returns_ticketed_rooms_shared_for_ten_minutes(self):
        fake = FakeX([x_item(ID_A, "Guitar hang", 40), x_item(ID_B, "Acoustic", 5)])
        reply = self.make(fake, Tickets(b"k")).search_raw("q=guitar")
        self.assertEqual((reply.status, reply.cdn_seconds), (200, FRESH_SECONDS))
        self.assertEqual([r["id"] for r in reply.body["data"]], [ID_A, ID_B])
        self.assertTrue(all(len(r["ticket"]) == 16 for r in reply.body["data"]))
        self.assertEqual(reply.body["meta"]["word"], "guitar")
        self.assertIn("query=guitar", fake.urls[0])

    def test_bad_spellings_never_reach_x(self):
        fake = FakeX([x_item(ID_A)])
        svc = self.make(fake)
        for raw in ("q=Guitar", "q=guitar&x=1", "q=%3Cscript%3E", ""):
            reply = svc.search_raw(raw)
            self.assertEqual((reply.status, reply.cdn_seconds), (400, 0), raw)
        self.assertEqual(fake.urls, [])

    def test_trouble_and_no_key(self):
        reply = self.make(FakeX(error=TimeoutError("slow"))).search_raw("q=guitar")
        self.assertEqual((reply.status, reply.cdn_seconds), (502, TROUBLE_SECONDS))
        empty = self.make().search_raw("q=guitar")
        self.assertEqual((empty.status, empty.body["data"]), (200, []))


if __name__ == "__main__":
    unittest.main()
