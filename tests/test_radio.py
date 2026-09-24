"""Space Radio tests. No network: the X API is a fake that records its calls."""
import json
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer
from pathlib import Path

from spaces_radio.budget import PRICE_PER_SPACE, Budget
from spaces_radio.server import make_handler
from spaces_radio.service import FRESH_SECONDS, TROUBLE_SECONDS, RadioService, service_from_env
from spaces_radio.sources import SourceError, XApiSource, gather
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


class GatherTests(TmpCase):
    def test_one_failing_source_does_not_silence_others(self):
        good = XApiSource("tok", Budget(self.dir / "a.json"), fetch=FakeX([x_item(ID_C)]))
        bad = XApiSource("tok", Budget(self.dir / "b.json"), fetch=FakeX(error=TimeoutError("slow")))
        rooms, problems = gather([bad, good], "music")
        self.assertEqual([r.id for r in rooms], [ID_C])
        self.assertEqual(len(problems), 1)

    def test_station_merges_words_busiest_first(self):
        fake = FakeX([x_item(ID_A, listeners=5), x_item(ID_B, listeners=90)])
        src = XApiSource("tok", Budget(self.dir / "b.json"), fetch=fake)
        rooms, _ = tune("music", [src])
        self.assertEqual([r.id for r in rooms], [ID_B, ID_A])
        self.assertEqual(len(fake.urls), len(STATIONS["music"]))
        self.assertEqual({r.topic for r in rooms}, {"music"})

    def test_counts_hosts_and_speakers_without_user_lookups(self):
        fake = FakeX([x_item(ID_A, host_ids=["1"], speaker_ids=["2", "3"])])
        src = XApiSource("tok", Budget(self.dir / "b.json"), fetch=fake)
        room = src.live("music")[0]
        self.assertEqual((room.hosts, room.speakers), (1, 2))
        self.assertIn("speaker_ids", fake.urls[0])
        self.assertNotIn("expansions", fake.urls[0])

    def test_unknown_station(self):
        with self.assertRaises(KeyError):
            tune("nope", [])


class ServiceTests(TmpCase):
    def make(self, fake=None):
        budget = Budget(self.dir / "b.json")
        source = XApiSource("tok", budget, fetch=fake) if fake else None
        return RadioService(source, budget)

    def test_no_key_answers_empty_and_says_so(self):
        svc = self.make()
        self.assertFalse(svc.status().body["data"]["live_search"])
        reply = svc.tune({"station": ["music"]})
        self.assertEqual((reply.status, reply.body["data"]), (200, []))

    def test_good_answer_is_shared_for_ten_minutes(self):
        reply = self.make(FakeX([x_item(ID_A)])).tune({"station": ["music"]})
        self.assertEqual(reply.status, 200)
        self.assertEqual(reply.cdn_seconds, FRESH_SECONDS)
        self.assertEqual(reply.body["data"][0]["url"], f"https://x.com/i/spaces/{ID_A}")

    def test_trouble_is_cached_briefly(self):
        reply = self.make(FakeX(error=TimeoutError("slow"))).tune({"station": ["music"]})
        self.assertEqual(reply.cdn_seconds, TROUBLE_SECONDS)
        self.assertTrue(reply.body["meta"]["problems"])

    def test_extra_params_are_refused_so_cache_cannot_be_split(self):
        fake = FakeX([x_item(ID_A)])
        reply = self.make(fake).tune({"station": ["music"], "bust": ["123"]})
        self.assertEqual((reply.status, reply.cdn_seconds), (400, 0))
        self.assertEqual(fake.urls, [])

    def test_unknown_station_refused(self):
        self.assertEqual(self.make().tune({"station": ["hack"]}).status, 400)

    def test_env_wiring(self):
        env = {"SPACES_RADIO_DATA": str(self.dir), "X_BEARER_TOKEN": " tok "}
        self.assertTrue(service_from_env(env).live_search)
        self.assertFalse(service_from_env({"SPACES_RADIO_DATA": str(self.dir)}).live_search)


class ServerTests(TmpCase):
    def setUp(self):
        super().setUp()
        service = RadioService(XApiSource("tok", Budget(self.dir / "b.json"),
                                          fetch=FakeX([x_item(ID_A, "Hi")])), Budget(self.dir / "b.json"))
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), make_handler(service))
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.base = f"http://127.0.0.1:{self.server.server_address[1]}"

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        super().tearDown()

    def get(self, path):
        try:
            with urllib.request.urlopen(self.base + path) as r:
                return r.status, r.headers, r.read()
        except urllib.error.HTTPError as e:
            return e.code, e.headers, e.read()

    def test_tune_sets_cdn_cache(self):
        code, headers, body = self.get("/api/tune?station=laughs")
        self.assertEqual(code, 200)
        self.assertEqual(json.loads(body)["data"][0]["id"], ID_A)
        self.assertIn(f"max-age={FRESH_SECONDS}", headers["Vercel-CDN-Cache-Control"])

    def test_errors_are_not_cached(self):
        code, headers, _ = self.get("/api/tune?station=hack")
        self.assertEqual(code, 400)
        self.assertEqual(headers["Cache-Control"], "no-store")

    def test_serves_page_and_modules_but_not_outside_public(self):
        self.assertIn(b"<title>Space Radio</title>", self.get("/")[2])
        self.assertEqual(self.get("/js/rooms.js")[0], 200)
        self.assertEqual(self.get("/../spaces_radio/service.py")[0], 404)
        self.assertEqual(self.get("/%2e%2e/README.md")[0], 404)


class VercelHandlerTests(TmpCase):
    """Load api/*.py the way Vercel does and serve them."""

    def serve(self, name):
        import importlib.util
        import os
        root = Path(__file__).resolve().parent.parent
        spec = importlib.util.spec_from_file_location(f"api_{name}", root / "api" / f"{name}.py")
        module = importlib.util.module_from_spec(spec)
        os.environ["SPACES_RADIO_DATA"] = str(self.dir)
        os.environ.pop("X_BEARER_TOKEN", None)
        import spaces_radio.service as service
        service._shared = None
        spec.loader.exec_module(module)
        server = ThreadingHTTPServer(("127.0.0.1", 0), module.handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        return f"http://127.0.0.1:{server.server_address[1]}"

    def test_status_and_tune_functions(self):
        with urllib.request.urlopen(self.serve("status") + "/api/status") as r:
            self.assertIn("music", json.loads(r.read())["data"]["stations"])
        with urllib.request.urlopen(self.serve("tune") + "/api/tune?station=music") as r:
            self.assertEqual(json.loads(r.read())["data"], [])


if __name__ == "__main__":
    unittest.main()
