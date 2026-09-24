"""Spaces Radio tests. No network: the X API is a fake that records its calls."""
import json
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer
from pathlib import Path

from spaces_radio.budget import PRICE_PER_SPACE, Budget
from spaces_radio.server import Radio, make_handler
from spaces_radio.sources import SavedSource, SourceError, XApiSource, gather
from spaces_radio.space import Space, parse_space_id
from spaces_radio.stations import STATIONS, tune

ID_A, ID_B, ID_C = "1YqKDqWqdPLxV", "1OwxWzqXyLbJQ", "1gqxvQoBjBVJB"


def x_item(space_id, title="Room", listeners=10, **extra):
    return {"id": space_id, "title": title, "participant_count": listeners,
            "state": "live", "started_at": "2026-09-23T20:00:00.000Z", **extra}


class FakeX:
    def __init__(self, items=(), error=None):
        self.items, self.error, self.urls = list(items), error, []

    def __call__(self, url, token):
        self.urls.append(url)
        if self.error:
            raise self.error
        return {"data": self.items}


class Clock:
    def __init__(self, t=1000.0):
        self.t = t

    def __call__(self):
        return self.t


class TmpCase(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self._tmp.name)

    def tearDown(self):
        self._tmp.cleanup()


class ParseTests(unittest.TestCase):
    def test_links_and_ids(self):
        self.assertEqual(parse_space_id(f"https://x.com/i/spaces/{ID_A}"), ID_A)
        self.assertEqual(parse_space_id(f"https://twitter.com/i/spaces/{ID_A}?s=20"), ID_A)
        self.assertEqual(parse_space_id(f"  {ID_A} "), ID_A)

    def test_rejects_junk(self):
        for bad in ("", "https://x.com/home", "<script>", "a/b", None):
            self.assertIsNone(parse_space_id(bad))

    def test_space_is_immutable_and_tagging_copies(self):
        s = Space(id=ID_A, title="t")
        t = s.tagged("music")
        self.assertEqual((s.topic, t.topic), ("", "music"))
        with self.assertRaises(Exception):
            s.title = "changed"


class BudgetTests(TmpCase):
    def test_charges_each_space_once_per_day(self):
        b = Budget(self.dir / "b.json", daily_cap=1.0, clock=lambda: "2026-09-23")
        b.charge([ID_A, ID_B])
        b.charge([ID_A])
        self.assertAlmostEqual(b.ledger().spent, 2 * PRICE_PER_SPACE)
        self.assertEqual(b.ledger().calls, 2)

    def test_refuses_call_that_could_pass_cap(self):
        b = Budget(self.dir / "b.json", daily_cap=0.05, clock=lambda: "2026-09-23")
        self.assertTrue(b.can_afford(10))
        self.assertFalse(b.can_afford(11))

    def test_new_day_resets_and_file_survives_restart(self):
        day = ["2026-09-23"]
        b = Budget(self.dir / "b.json", clock=lambda: day[0])
        b.charge([ID_A])
        again = Budget(self.dir / "b.json", clock=lambda: day[0])
        self.assertEqual(again.ledger().spent, PRICE_PER_SPACE)
        day[0] = "2026-09-24"
        self.assertEqual(again.ledger().spent, 0)

    def test_damaged_ledger_fails_closed(self):
        (self.dir / "b.json").write_text("{not json")
        b = Budget(self.dir / "b.json", daily_cap=0.5, clock=lambda: "2026-09-23")
        self.assertFalse(b.can_afford(1))


class XApiTests(TmpCase):
    def make(self, fake, cap=1.0, clock=None):
        budget = Budget(self.dir / "b.json", daily_cap=cap, clock=lambda: "2026-09-23")
        return XApiSource("tok", budget, max_results=20, fetch=fake, now=clock or Clock()), budget

    def test_maps_live_rooms_and_skips_ticketed(self):
        fake = FakeX([x_item(ID_A, "Guitar hang", 40), x_item(ID_B, is_ticketed=True)])
        src, budget = self.make(fake)
        rooms = src.live("guitar")
        self.assertEqual([r.id for r in rooms], [ID_A])
        self.assertEqual((rooms[0].listeners, rooms[0].source), (40, "x-api"))
        self.assertIn("state=live", fake.urls[0])
        self.assertIn("query=guitar", fake.urls[0])
        self.assertEqual(budget.ledger().spent, PRICE_PER_SPACE)

    def test_cache_prevents_repeat_calls(self):
        clock = Clock()
        fake = FakeX([x_item(ID_A)])
        src, _ = self.make(fake, clock=clock)
        src.live("music"); src.live("music")
        self.assertEqual(len(fake.urls), 1)
        clock.t += 601
        src.live("music")
        self.assertEqual(len(fake.urls), 2)

    def test_budget_exhausted_means_no_call(self):
        fake = FakeX([x_item(ID_A)])
        src, _ = self.make(fake, cap=0.01)
        with self.assertRaises(SourceError):
            src.live("music")
        self.assertEqual(fake.urls, [])

    def test_http_errors_become_plain_words(self):
        err = urllib.error.HTTPError("u", 402, "Payment Required", {}, None)
        src, _ = self.make(FakeX(error=err))
        with self.assertRaisesRegex(SourceError, "credits"):
            src.live("music")

    def test_needs_token(self):
        with self.assertRaises(ValueError):
            XApiSource("", Budget(self.dir / "b.json"))


class SavedTests(TmpCase):
    def test_add_dedupes_and_remove(self):
        saved = SavedSource(self.dir / "s.json")
        saved.add(f"https://x.com/i/spaces/{ID_A}", "Late night guitar")
        saved.add(ID_A, "Renamed")
        self.assertEqual([(r.id, r.title) for r in saved.all()], [(ID_A, "Renamed")])
        self.assertTrue(saved.remove(ID_A))
        self.assertFalse(saved.remove(ID_A))

    def test_bad_link_rejected(self):
        with self.assertRaises(ValueError):
            SavedSource(self.dir / "s.json").add("https://x.com/home")


class GatherTests(TmpCase):
    def test_one_failing_source_does_not_silence_others(self):
        saved = SavedSource(self.dir / "s.json")
        saved.add(ID_C, "Mine")
        src = XApiSource("tok", Budget(self.dir / "b.json"), fetch=FakeX(error=TimeoutError("slow")))
        rooms, problems = gather([src, saved], "music")
        self.assertEqual([r.id for r in rooms], [ID_C])
        self.assertEqual(len(problems), 1)

    def test_station_merges_words_live_first_busiest_first(self):
        fake = FakeX([x_item(ID_A, listeners=5), x_item(ID_B, listeners=90)])
        saved = SavedSource(self.dir / "s.json")
        saved.add(ID_C, "Mine", topic="faith")
        src = XApiSource("tok", Budget(self.dir / "b.json"), fetch=fake)
        rooms, _ = tune("music", [src, saved])
        self.assertEqual([r.id for r in rooms], [ID_B, ID_A, ID_C])
        self.assertEqual(len(fake.urls), len(STATIONS["music"]))
        self.assertEqual([r.topic for r in rooms], ["music", "music", "faith"])

    def test_unknown_station(self):
        with self.assertRaises(KeyError):
            tune("nope", [])


class ServerTests(TmpCase):
    def setUp(self):
        super().setUp()
        self.radio = Radio(self.dir)
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), make_handler(self.radio))
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.base = f"http://127.0.0.1:{self.server.server_address[1]}"

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        super().tearDown()

    def call(self, path, method="GET", body=None):
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(self.base + path, data=data, method=method,
                                     headers={"Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req) as r:
                return r.status, json.loads(r.read())
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read())

    def test_status_without_key_is_free_mode(self):
        code, body = self.call("/api/status")
        self.assertEqual(code, 200)
        self.assertFalse(body["data"]["live_search"])
        self.assertIn("music", body["data"]["stations"])

    def test_save_tune_remove_roundtrip(self):
        code, body = self.call("/api/saved", "POST", {"link": f"https://x.com/i/spaces/{ID_A}", "title": "Hi"})
        self.assertEqual((code, body["data"]["id"]), (201, ID_A))
        code, body = self.call("/api/tune?station=laughs")
        self.assertEqual([r["id"] for r in body["data"]], [ID_A])
        self.assertEqual(self.call(f"/api/saved/{ID_A}", "DELETE")[0], 200)
        self.assertEqual(self.call(f"/api/saved/{ID_A}", "DELETE")[0], 404)

    def test_bad_inputs(self):
        self.assertEqual(self.call("/api/tune?station=hack")[0], 400)
        code, body = self.call("/api/saved", "POST", {"link": "nope"})
        self.assertEqual(code, 400)
        self.assertFalse(body["success"])
        self.assertEqual(self.call("/api/saved", "POST", ["list"])[0], 400)

    def test_serves_page(self):
        with urllib.request.urlopen(self.base + "/") as r:
            self.assertIn(b"Spaces Radio", r.read())


if __name__ == "__main__":
    unittest.main()
