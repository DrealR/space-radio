"""Crew manifest tests: who is aboard a Space. No network: X is a fake that records its calls."""
import contextlib
import io
import json
import os
import threading
import unittest
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

from spaces_radio.budget import PRICE_PER_SPACE, PRICE_PER_USER, Budget
from spaces_radio.crew import (MAX_CREW, CrewError, CrewLookup, crew_url, normalize_person,
                               parse_crew, valid_crew_id)
from spaces_radio.server import make_handler
from spaces_radio.service import RadioService, service_from_env
from tests.test_radio import Clock, TmpCase

SID, ID_B, ID_C = "1YqKDqWqdPLxV", "1OwxWzqXyLbJQ", "1gqxvQoBjBVJB"
DAY = "2026-09-24"


def user(uid, username, name=None, **extra):
    return {"id": uid, "username": username, "name": name or username.title(), **extra}


USERS = [user("1", "captain"), user("2", "cohost"), user("3", "speaker")]


def crew_body(space_id=SID, users=USERS, **data):
    """X's lookup answer: creator 1 (also in host_ids), co-host 2 (also in speaker_ids), speaker 3."""
    base = {"id": space_id, "state": "live", "title": "Room", "participant_count": 50,
            "started_at": "2026-09-24T18:00:00.000Z", "lang": "en",
            "creator_id": "1", "host_ids": ["1", "2"], "speaker_ids": ["2", "3"]}
    return {"data": {**base, **data}, "includes": {"users": list(users)}}


def http_error(code):
    return urllib.error.HTTPError("https://api.x.com/2/spaces/x", code, "err", {}, None)


def query_of(url):
    return {k: v[0] for k, v in parse_qs(urlsplit(url).query).items()}


def as_x_would(body, url):
    """Like X, name only who the expansions ask for: nobody (a probe), the creator, or everyone."""
    wanted = query_of(url).get("expansions", "")
    if not isinstance(body, dict) or wanted == "creator_id,host_ids,speaker_ids":
        return body
    if not wanted:
        return {k: v for k, v in body.items() if k != "includes"}
    creator = (body.get("data") or {}).get("creator_id")
    users = [u for u in body.get("includes", {}).get("users", []) if isinstance(u, dict) and u.get("id") == creator]
    return {**body, "includes": {"users": users}}


class FakeCrewX:
    """Records every URL it is asked for; answers with one body (as X would), or raises.
    `fail_on`: raise only for URLs asking for these expansions ("" is the probe)."""

    def __init__(self, body=None, error=None, fail_on=None):
        self.body, self.error, self.fail_on, self.urls = body, error, fail_on, []

    def __call__(self, url, token):
        self.urls.append(url)
        failing = self.fail_on is None or query_of(url).get("expansions", "") in self.fail_on
        if self.error and failing:
            raise self.error
        return as_x_would(self.body, url)


class EchoX(FakeCrewX):
    """Answers every lookup with a live crew for the room it was asked about."""

    def __call__(self, url, token):
        self.urls.append(url)
        return as_x_would(crew_body(space_id=urlsplit(url).path.rsplit("/", 1)[-1]), url)


class CrewParseTests(unittest.TestCase):
    def test_roles_in_order_and_each_person_once(self):
        scan = parse_crew(crew_body(), SID, "full")
        self.assertEqual([(p.id, p.role) for p in scan.crew], [("1", "host"), ("2", "cohost"), ("3", "speaker")])
        self.assertEqual((scan.hosts, scan.speakers), (2, 1))
        self.assertEqual(scan.to_json()["counts"], {"hosts": 2, "speakers": 1})
        self.assertEqual(scan.to_json()["others"], 47)

    def test_first_host_id_stands_in_for_a_missing_creator(self):
        body = crew_body(creator_id=None, host_ids=["2", "1"])
        self.assertEqual([(p.id, p.role) for p in parse_crew(body, SID, "full").crew][:2],
                         [("2", "host"), ("1", "cohost")])

    def test_counts_come_from_id_lists_and_others_never_go_negative(self):
        body = crew_body(users=[], participant_count=1, host_ids=["2"], speaker_ids=["1", "3", "4"])
        scan = parse_crew(body, SID, "full")
        self.assertEqual((scan.hosts, scan.speakers, scan.others), (2, 2, 0))
        self.assertEqual(scan.crew, ())

    def test_users_with_bad_handles_or_ids_are_dropped(self):
        users = [user("1", "captain"), user("2", "not a handle"), user("3", "x" * 16), user("3x", "spk")]
        self.assertEqual([p.id for p in parse_crew(crew_body(users=users), SID, "full").crew], ["1"])

    def test_names_are_cleaned_but_keep_rtl_and_emoji(self):
        person = normalize_person(user("1", "noor", "نور\u202e  🎧\u0007\tDJ \u2066👩\u200d🚀"), "host")
        self.assertEqual(person.name, "نور 🎧 DJ 👩\u200d🚀")
        self.assertEqual(len(normalize_person(user("1", "long", "é" * 80), "host").name), 50)
        self.assertEqual(normalize_person(user("1", "blank", "\u202e \u0007"), "host").name, "@blank")
        self.assertEqual(normalize_person(user("1", "ghost", "\u200b\u2060\ufeff"), "host").name, "@ghost")
        flag = "\U0001F3F4\U000E0067\U000E0062\U000E0065\U000E006E\U000E0067\U000E007F"  # England: tag characters
        self.assertEqual(normalize_person(user("1", "fan", f"Fan {flag}"), "host").name, f"Fan {flag}")

    def test_avatars_only_from_x_images_over_https_and_bigger(self):
        good = "https://pbs.twimg.com/profile_images/123/AbC_normal.jpg"
        person = normalize_person(user("1", "a", profile_image_url=good), "host")
        self.assertEqual(person.avatar, "https://pbs.twimg.com/profile_images/123/AbC_200x200.jpg")
        self.assertEqual(person.avatar_small, good)
        default = "https://abs.twimg.com/sticky/default_profile_images/default_profile_normal.png"
        self.assertTrue(normalize_person(user("1", "a", profile_image_url=default), "host").avatar.endswith("_200x200.png"))
        for bad in ("http://pbs.twimg.com/a_normal.jpg", "https://evil.com/a_normal.jpg",
                    "https://pbs.twimg.com.evil.com/a.jpg", "https://me@pbs.twimg.com/a.jpg",
                    "https://pbs.twimg.com:8443/a.jpg", "javascript:alert(1)", "https://pbs.twimg.com/a b.jpg",
                    "https://pbs.twimg.com/a.jpg?x=1", 42, None):
            person = normalize_person(user("1", "a", profile_image_url=bad), "host")
            self.assertEqual((person.avatar, person.avatar_small), ("", ""), bad)

    def test_only_a_trailing_normal_before_the_extension_is_swapped(self):
        url = "https://pbs.twimg.com/profile_images/1/_normal_dir/pic_400x400.webp"
        self.assertEqual(normalize_person(user("1", "a", profile_image_url=url), "host").avatar, url)

    def test_verified_and_protected_are_normalized(self):
        cases = [({"verified_type": "business"}, "business"), ({"verified_type": "government"}, "government"),
                 ({"verified": True}, "blue"), ({"verified": True, "verified_type": "none"}, "blue"),
                 ({"verified_type": "gold", "verified": "yes"}, ""), ({}, "")]
        for extra, want in cases:
            self.assertEqual(normalize_person(user("1", "a", **extra), "host").verified, want, extra)
        self.assertTrue(normalize_person(user("1", "a", protected=True), "host").protected)
        self.assertFalse(normalize_person(user("1", "a", protected="true"), "host").protected)

    def test_crew_is_capped(self):
        many = [str(i) for i in range(10, 60)]
        body = crew_body(users=[user("1", "captain")] + [user(i, f"s{i}") for i in many], speaker_ids=many)
        self.assertEqual(len(parse_crew(body, SID, "full").crew), MAX_CREW)

    def test_host_only_mode_names_at_most_the_host(self):
        scan = parse_crew(crew_body(), SID, "host-only")
        self.assertEqual([p.role for p in scan.crew], ["host"])
        self.assertEqual((scan.hosts, scan.speakers, scan.mode), (2, 1, "host-only"))

    def test_ended_three_ways_and_scheduled(self):
        gone = {"errors": [{"type": "https://api.twitter.com/2/problems/resource-not-found"}]}
        self.assertEqual(parse_crew(gone, SID, "full").state, "ended")
        ended = parse_crew(crew_body(state="ended"), SID, "full")
        self.assertEqual((ended.state, ended.crew, ended.listeners), ("ended", (), 0))
        scheduled = parse_crew(crew_body(state="scheduled"), SID, "full")
        self.assertEqual((scheduled.state, scheduled.crew), ("scheduled", ()))

    def test_wrong_or_broken_answers_are_upstream_errors(self):
        for body in (crew_body(space_id="1OwxWzqXyLbJQ"), [], "x", {}, {"data": None},
                     crew_body(state="weird"), crew_body(state=["live"])):
            with self.assertRaises(CrewError) as caught:
                parse_crew(body, SID, "full")
            self.assertEqual(caught.exception.reason, "upstream")

    def test_room_fields_are_validated(self):
        body = crew_body(title="\u202e", started_at="yesterday", lang="x" * 17, participant_count="12")
        scan = parse_crew(body, SID, "full").to_json()
        self.assertEqual((scan["title"], scan["started_at"], scan["lang"], scan["listeners"]),
                         ("Untitled room", "", "", 12))
        self.assertEqual(len(parse_crew(crew_body(title="t" * 300), SID, "full").title), 200)

    def test_json_shape_matches_the_contract(self):
        data = parse_crew(crew_body(), SID, "full").to_json()
        self.assertEqual(set(data), {"id", "state", "title", "listeners", "started_at", "lang",
                                     "url", "crew", "counts", "others"})
        self.assertEqual(data["url"], f"https://x.com/i/spaces/{SID}")
        self.assertEqual(set(data["crew"][0]), {"id", "role", "name", "username", "avatar", "avatar_small",
                                                "verified", "protected", "profile_url"})
        self.assertEqual(data["crew"][0]["profile_url"], "https://x.com/captain")
        json.dumps(data)


class CrewUrlTests(unittest.TestCase):
    def test_full_lookup_asks_for_people_and_nothing_more(self):
        url = crew_url(SID, "full")
        self.assertTrue(url.startswith(f"https://api.x.com/2/spaces/{SID}?"))
        q = query_of(url)
        self.assertEqual(q["expansions"], "creator_id,host_ids,speaker_ids")
        self.assertEqual(q["user.fields"], "name,username,profile_image_url,verified,verified_type,protected")
        self.assertIn("participant_count", q["space.fields"])
        self.assertNotIn("invited_user_ids", url)
        self.assertNotIn("topic_ids", url)

    def test_host_only_lookup(self):
        self.assertEqual(query_of(crew_url(SID, "host-only"))["expansions"], "creator_id")

    def test_probe_asks_for_the_space_alone(self):
        q = query_of(crew_url(SID, "probe"))
        self.assertEqual(set(q), {"space.fields"})
        self.assertIn("speaker_ids", q["space.fields"])

    def test_ids_must_be_bare(self):
        self.assertEqual(valid_crew_id(SID), SID)
        self.assertEqual(valid_crew_id("1FakeRoom"), "1FakeRoom")
        for bad in (f"https://x.com/i/spaces/{SID}", SID + "A", "1234567", SID + "\n", " " + SID, None, 12345678):
            self.assertIsNone(valid_crew_id(bad), bad)
        with self.assertRaises(ValueError):
            crew_url(f"x.com/i/spaces/{SID}", "full")


class CrewBudgetTests(TmpCase):
    def test_price_per_user_drives_the_cap(self):
        b = Budget(self.dir / "c.json", daily_cap=0.10, clock=lambda: DAY, price=PRICE_PER_USER)
        self.assertTrue(b.can_afford(10))
        self.assertFalse(b.can_afford(11))
        b.charge(["1", "2", "2"])
        self.assertAlmostEqual(b.ledger().spent, 2 * PRICE_PER_USER)

    def test_old_ledger_without_price_loads_fine(self):
        (self.dir / "c.json").write_text(json.dumps({"day": DAY, "paid_ids": ["1", "2"], "calls": 1}))
        b = Budget(self.dir / "c.json", daily_cap=0.5, clock=lambda: DAY, price=PRICE_PER_USER)
        self.assertAlmostEqual(b.ledger().spent, 0.02)
        self.assertTrue(b.can_afford(1))

    def test_damaged_ledger_fails_closed_at_any_price(self):
        (self.dir / "c.json").write_text(json.dumps({"day": DAY, "paid_ids": "abc", "calls": 1}))
        with contextlib.redirect_stdout(io.StringIO()):
            b = Budget(self.dir / "c.json", daily_cap=0.5, clock=lambda: DAY, price=PRICE_PER_USER)
        self.assertFalse(b.can_afford(1))

    def test_default_price_is_unchanged(self):
        b = Budget(self.dir / "b.json", clock=lambda: DAY)
        b.charge(["a"])
        self.assertAlmostEqual(b.ledger().spent, PRICE_PER_SPACE)
        saved = json.loads((self.dir / "b.json").read_text())
        self.assertEqual(saved["paid_ids"], ["0:a"])  # keyed per call: repeats are billed again


class CrewLookupTests(TmpCase):
    def make(self, fake, crew_cap=0.5, clock=None, **extra):
        self.clock = clock or Clock()
        self.spaces = Budget(self.dir / "b.json", clock=lambda: DAY)
        self.users = Budget(self.dir / "c.json", daily_cap=crew_cap, clock=lambda: DAY, price=PRICE_PER_USER)
        self.lines = []
        return CrewLookup("tok", self.spaces, self.users, fetch=fake, now=self.clock, log=self.lines.append, **extra)

    def test_full_scan_charges_everyone_on_every_scan(self):
        fake = FakeCrewX(crew_body())
        crew = self.make(fake)
        scan, cached = crew.scan(SID)
        self.assertEqual((scan.mode, cached, len(scan.crew)), ("full", False, 3))
        # A probe (the Space, no names), then the named lookup.
        self.assertEqual([query_of(u).get("expansions", "") for u in fake.urls],
                         ["", "creator_id,host_ids,speaker_ids"])
        self.assertAlmostEqual(self.users.ledger().spent, 3 * PRICE_PER_USER)
        self.assertAlmostEqual(self.spaces.ledger().spent, PRICE_PER_SPACE)
        self.clock.t += 121
        crew.scan(SID)
        self.assertEqual(len(fake.urls), 4)
        self.assertAlmostEqual(self.users.ledger().spent, 6 * PRICE_PER_USER)
        self.assertAlmostEqual(self.spaces.ledger().spent, 2 * PRICE_PER_SPACE)

    def test_users_x_returns_are_charged_even_when_dropped(self):
        crew = self.make(FakeCrewX(crew_body(users=USERS + [user("99", "bad handle!"), {"name": "no id"}])))
        crew.scan(SID)
        self.assertAlmostEqual(self.users.ledger().spent, 5 * PRICE_PER_USER)

    def test_every_returned_user_is_charged_even_past_the_parse_limit(self):
        crowd = [user(str(1000 + i), f"u{i}") for i in range(120)]
        self.make(FakeCrewX(crew_body(users=crowd))).scan(SID)
        self.assertAlmostEqual(self.users.ledger().spent, 120 * PRICE_PER_USER)

    def test_tight_cap_falls_back_to_host_only(self):
        fake = FakeCrewX(crew_body())
        scan, _ = self.make(fake, crew_cap=0.05).scan(SID)  # 3 names + a margin of 3 won't fit
        self.assertEqual(scan.mode, "host-only")
        self.assertEqual(query_of(fake.urls[-1])["expansions"], "creator_id")
        self.assertAlmostEqual(self.users.ledger().spent, PRICE_PER_USER)

    def test_spent_cap_refuses_without_calling_x(self):
        fake = FakeCrewX(crew_body())
        with self.assertRaises(CrewError) as caught:
            self.make(fake, crew_cap=0.005).scan(SID)
        self.assertEqual(caught.exception.reason, "budget")
        self.assertEqual(fake.urls, [])

    def test_live_roster_is_cached_two_minutes(self):
        fake = FakeCrewX(crew_body())
        crew = self.make(fake)
        crew.scan(SID)
        self.clock.t += 119
        self.assertTrue(crew.scan(SID)[1])
        self.assertEqual(len(fake.urls), 2)
        self.clock.t += 2
        self.assertFalse(crew.scan(SID)[1])
        self.assertEqual(len(fake.urls), 4)

    def test_settled_rooms_are_cached_ten_minutes(self):
        fake = FakeCrewX(crew_body(state="ended"))
        crew = self.make(fake)
        crew.scan(SID)
        self.clock.t += 300
        self.assertTrue(crew.scan(SID)[1])
        self.clock.t += 301
        crew.scan(SID)
        self.assertEqual(len(fake.urls), 2)

    def test_x_404_means_the_room_ended(self):
        scan, _ = self.make(FakeCrewX(error=http_error(404))).scan(SID)
        self.assertEqual((scan.state, scan.crew), ("ended", ()))
        self.assertEqual(self.users.ledger().spent, 0)

    def test_failures_map_to_reasons_and_are_not_cached(self):
        cases = [(http_error(500), "upstream"), (urllib.error.URLError("dns"), "offline"),
                 (TimeoutError("slow"), "offline"), (ConnectionResetError("reset"), "offline"),
                 (ValueError("bad json"), "upstream")]
        for error, reason in cases:
            fake = FakeCrewX(error=error)
            crew = self.make(fake)
            for _ in range(2):
                with self.assertRaises(CrewError) as caught:
                    crew.scan(SID)
                self.assertEqual(caught.exception.reason, reason, error)
            self.assertEqual(len(fake.urls), 2)

    def test_when_x_refuses_the_app_nobody_asks_again_for_a_while(self):
        cases = [(http_error(402), "credits", 60), (http_error(429), "rate", 30),
                 (http_error(401), "auth", 60), (http_error(403), "auth", 60)]
        for error, reason, seconds in cases:
            fake = FakeCrewX(error=error)
            crew = self.make(fake)
            for sid in (SID, ID_B):  # the second room is held too: X's limit is the app's, not the room's
                with self.assertRaises(CrewError) as caught:
                    crew.scan(sid)
                self.assertEqual(caught.exception.reason, reason, error)
            self.assertEqual(len(fake.urls), 1, error)
            self.clock.t += seconds + 1
            with self.assertRaises(CrewError):
                crew.scan(SID)
            self.assertEqual(len(fake.urls), 2, error)

    def test_logs_one_line_without_names(self):
        self.make(FakeCrewX(crew_body())).scan(SID)
        self.assertEqual(self.lines, [f"[spaces-radio] crew {SID} mode=full users=3 crew_spent_today=$0.030"])
        for u in USERS:
            self.assertNotIn(u["username"], self.lines[0])
            self.assertNotIn(u["name"], self.lines[0])

    def test_local_guard_limits_upstream_calls_per_minute(self):
        fake = EchoX()
        crew = self.make(fake, max_calls_per_minute=4)  # a live room takes two calls
        crew.scan(SID)
        crew.scan(ID_B)
        with self.assertRaises(CrewError) as caught:
            crew.scan(ID_C)
        self.assertEqual((caught.exception.reason, len(fake.urls)), ("rate", 4))
        self.clock.t += 60  # the local guard is not X refusing: no hold, the next minute works
        self.assertEqual(crew.scan(ID_C)[0].id, ID_C)
        self.assertEqual(len(fake.urls), 6)

    def test_bad_id_and_missing_token(self):
        with self.assertRaises(CrewError) as caught:
            self.make(FakeCrewX(crew_body())).scan("https://x.com/i/spaces/" + SID)
        self.assertEqual(caught.exception.reason, "bad-id")
        with self.assertRaises(ValueError):
            CrewLookup("", Budget(self.dir / "b.json"), Budget(self.dir / "c.json"))


class CrewServiceTests(TmpCase):
    def make(self, fake=None, crew_cap=0.5):
        spaces = Budget(self.dir / "b.json", clock=lambda: DAY)
        users = Budget(self.dir / "c.json", daily_cap=crew_cap, clock=lambda: DAY, price=PRICE_PER_USER)
        self.lines = []
        crew = CrewLookup("tok", spaces, users, fetch=fake, log=self.lines.append) if fake else None
        return RadioService(None, spaces, crew)

    def assertReason(self, reply, status, reason, cdn):
        self.assertEqual((reply.status, reply.body["meta"].get("reason"), reply.cdn_seconds), (status, reason, cdn))
        self.assertFalse(reply.body["success"])
        self.assertIsNone(reply.body["data"])
        self.assertTrue(reply.body["error"])

    def test_bad_requests_never_reach_x(self):
        fake = FakeCrewX(crew_body())
        svc = self.make(fake)
        self.assertReason(svc.crew({"id": [SID], "bust": ["1"]}), 400, "bad-request", 0)
        self.assertReason(svc.crew({"id": [SID, SID]}), 400, "bad-request", 0)
        self.assertReason(svc.crew({}), 400, "bad-id", 0)
        self.assertReason(svc.crew({"id": [""]}), 400, "bad-id", 0)
        self.assertReason(svc.crew({"id": [f"https://x.com/i/spaces/{SID}"]}), 400, "bad-id", 0)
        self.assertReason(svc.crew({"id": [SID + "A"]}), 400, "bad-id", 0)
        self.assertEqual(fake.urls, [])

    def test_no_crew_lookup_means_no_key(self):
        reply = self.make().crew({"id": [SID]})
        self.assertReason(reply, 503, "no-key", 300)
        self.assertIn("X's own page shows everyone", reply.body["error"])

    def test_x_trouble_maps_to_contract_statuses(self):
        cases = [(http_error(402), 503, "credits", 60), (http_error(429), 503, "rate", 30),
                 (http_error(401), 502, "auth", 60), (TimeoutError("slow"), 502, "offline", 30),
                 (ValueError("junk"), 502, "upstream", 30)]
        for error, status, reason, cdn in cases:
            self.assertReason(self.make(FakeCrewX(error=error)).crew({"id": [SID]}), status, reason, cdn)
        self.assertReason(self.make(FakeCrewX(crew_body()), crew_cap=0).crew({"id": [SID]}), 503, "budget", 60)

    def test_a_bug_still_answers_in_words(self):
        with contextlib.redirect_stderr(io.StringIO()) as err:
            reply = self.make(FakeCrewX(error=RuntimeError("boom"))).crew({"id": [SID]})
        self.assertReason(reply, 502, "upstream", 30)
        self.assertIn("RuntimeError", err.getvalue())

    def test_live_roster_is_shared_two_minutes(self):
        reply = self.make(FakeCrewX(crew_body())).crew({"id": [SID]})
        self.assertEqual((reply.status, reply.cdn_seconds, reply.body["success"]), (200, 120, True))
        self.assertEqual(reply.body["data"]["crew"][0]["username"], "captain")
        meta = reply.body["meta"]
        self.assertEqual((meta["mode"], meta["cached"]), ("full", False))
        self.assertRegex(meta["fetched_at"], r"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$")

    def test_settled_rooms_are_shared_ten_minutes(self):
        for body in (crew_body(state="ended"), crew_body(state="scheduled")):
            reply = self.make(FakeCrewX(body)).crew({"id": [SID]})
            self.assertEqual((reply.status, reply.cdn_seconds), (200, 600))
        self.assertEqual(self.make(FakeCrewX(error=http_error(404))).crew({"id": [SID]}).cdn_seconds, 600)


class CrewServerTests(TmpCase):
    def setUp(self):
        super().setUp()
        spaces = Budget(self.dir / "b.json")
        users = Budget(self.dir / "c.json", price=PRICE_PER_USER)
        crew = CrewLookup("tok", spaces, users, fetch=FakeCrewX(crew_body()), log=lambda line: None)
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), make_handler(RadioService(None, spaces, crew)))
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

    def test_crew_route_is_shared_by_the_cdn(self):
        with contextlib.redirect_stderr(io.StringIO()):
            code, headers, body = self.get(f"/api/crew?id={SID}")
        self.assertEqual(code, 200)
        self.assertEqual(headers["Content-Type"], "application/json")
        self.assertIn("max-age=120", headers["Vercel-CDN-Cache-Control"])
        self.assertEqual(json.loads(body)["data"]["id"], SID)

    def test_bad_crew_requests_are_not_cached(self):
        with contextlib.redirect_stderr(io.StringIO()):
            code, headers, body = self.get(f"/api/crew?id={SID}&id={SID}")
        self.assertEqual((code, headers["Cache-Control"]), (400, "no-store"))
        self.assertEqual(json.loads(body)["meta"]["reason"], "bad-request")


class CrewVercelTests(TmpCase):
    """Load api/crew.py the way Vercel does and serve it."""

    def setUp(self):
        super().setUp()
        saved = {k: os.environ.get(k) for k in ("SPACES_RADIO_DATA", "X_BEARER_TOKEN", "SPACES_RADIO_FAKE")}
        self.addCleanup(self._restore, saved)

    @staticmethod
    def _restore(saved):
        for key, value in saved.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value
        import spaces_radio.service as service
        service._shared = None

    def test_crew_function_without_a_key(self):
        import importlib.util
        root = Path(__file__).resolve().parent.parent
        spec = importlib.util.spec_from_file_location("api_crew", root / "api" / "crew.py")
        module = importlib.util.module_from_spec(spec)
        os.environ["SPACES_RADIO_DATA"] = str(self.dir)
        os.environ.pop("X_BEARER_TOKEN", None)
        os.environ.pop("SPACES_RADIO_FAKE", None)
        import spaces_radio.service as service
        service._shared = None
        spec.loader.exec_module(module)
        server = ThreadingHTTPServer(("127.0.0.1", 0), module.handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        url = f"http://127.0.0.1:{server.server_address[1]}/api/crew?id={SID}"
        with self.assertRaises(urllib.error.HTTPError) as caught:
            urllib.request.urlopen(url)
        self.assertEqual(caught.exception.code, 503)
        self.assertEqual(caught.exception.headers["Content-Type"], "application/json")
        self.assertEqual(json.loads(caught.exception.read())["meta"]["reason"], "no-key")


class CrewEnvTests(TmpCase):
    def env(self, **extra):
        return {"SPACES_RADIO_DATA": str(self.dir), "SPACES_RADIO_FAKE_DELAY": "0", **extra}

    def quiet(self, env):
        with contextlib.redirect_stdout(io.StringIO()) as out, contextlib.redirect_stderr(io.StringIO()):
            svc = service_from_env(env)
        return svc, out.getvalue()

    def test_a_key_turns_names_on_and_the_kill_switch_turns_them_off(self):
        self.assertTrue(self.quiet(self.env(X_BEARER_TOKEN="tok"))[0].crew_names)
        svc, _ = self.quiet(self.env(X_BEARER_TOKEN="tok", SPACES_RADIO_CREW="off"))
        self.assertFalse(svc.crew_names)
        self.assertEqual(svc.crew({"id": [SID]}).body["meta"]["reason"], "no-key")
        self.assertFalse(self.quiet(self.env())[0].crew_names)

    def test_fake_mode_serves_rooms_and_crew_without_network(self):
        svc, out = self.quiet(self.env(SPACES_RADIO_FAKE="1"))
        self.assertIn("FAKE X: no network, no cost", out)
        rooms = svc.tune({"station": ["music"]}).body["data"]
        self.assertEqual(len(rooms), 6)
        self.assertRegex(rooms[0]["ticket"], r"^[0-9a-f]{16}$")
        with contextlib.redirect_stderr(io.StringIO()):
            live = svc.crew({"id": [rooms[0]["id"]], "t": [rooms[0]["ticket"]]})
            unticketed = svc.crew({"id": [rooms[1]["id"]]})
            ended = svc.crew({"id": ["0000000ended"]})
            limited = svc.crew({"id": ["0000000limit"]})
        self.assertEqual(live.body["data"]["counts"], {"hosts": 3, "speakers": 6})
        self.assertEqual([p["role"] for p in live.body["data"]["crew"]].count("cohost"), 2)
        self.assertEqual(live.body["meta"]["mode"], "full")
        self.assertEqual([p["role"] for p in unticketed.body["data"]["crew"]], ["host"])
        self.assertEqual(unticketed.body["meta"]["mode"], "host-only")
        self.assertEqual(ended.body["data"]["state"], "ended")
        self.assertEqual((limited.status, limited.body["meta"]["reason"]), (503, "rate"))
        self.assertTrue((self.dir / "fake" / "x-crew-budget.json").exists())

    def test_fake_mode_is_ignored_on_vercel(self):
        svc, out = self.quiet(self.env(SPACES_RADIO_FAKE="1", VERCEL="1"))
        self.assertEqual(out, "")
        self.assertFalse(svc.live_search)
        self.assertEqual(svc.crew({"id": [SID]}).body["meta"]["reason"], "no-key")

    def test_a_bad_crew_cap_spends_nothing(self):
        svc, _ = self.quiet(self.env(SPACES_RADIO_FAKE="1", SPACES_RADIO_CREW_DAILY_CAP="lots"))
        with contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(svc.crew({"id": [SID]}).body["meta"]["reason"], "budget")
        svc, _ = self.quiet(self.env(SPACES_RADIO_FAKE="1", SPACES_RADIO_CREW_DAILY_CAP="inf"))
        with contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(svc.crew({"id": [SID]}).body["meta"]["reason"], "budget")


class FixtureTests(unittest.TestCase):
    def test_fake_search_rooms(self):
        from spaces_radio.fixtures import fake_fetch
        from spaces_radio.sources import SEARCH_URL
        rooms = fake_fetch(f"{SEARCH_URL}?query=music", "fake")["data"]
        self.assertEqual(len(rooms), 6)
        for room in rooms:
            self.assertRegex(room["id"], r"^[A-Za-z0-9]{13}$")
            self.assertEqual((room["state"], room["lang"]), ("live", "en"))
            self.assertTrue(room["host_ids"] and room["title"])

    def test_fake_rooms_started_within_two_hours(self):
        from datetime import datetime, timezone
        from spaces_radio.fixtures import search_body
        now = datetime(2026, 9, 24, 20, 0, tzinfo=timezone.utc)
        for room in search_body(now)["data"]:
            started = datetime.strptime(room["started_at"], "%Y-%m-%dT%H:%M:%S.000Z").replace(tzinfo=timezone.utc)
            self.assertTrue(0 < (now - started).total_seconds() < 7200)

    def test_fake_crew_exercises_every_person_state(self):
        from spaces_radio.fixtures import fake_fetch
        body = fake_fetch(crew_url("1FakeRoomAaaa", "full"), "fake")
        self.assertEqual(body["data"]["id"], "1FakeRoomAaaa")
        self.assertEqual(len(body["includes"]["users"]), 9)
        scan = parse_crew(body, "1FakeRoomAaaa", "full")
        people = scan.crew
        self.assertEqual(len(people), 8)
        self.assertEqual([p.role for p in people[:3]], ["host", "cohost", "cohost"])
        self.assertTrue(any(p.protected for p in people))
        self.assertTrue(any(p.verified == "business" for p in people))
        self.assertTrue(any(p.avatar.startswith("https://abs.twimg.com/") for p in people))
        self.assertTrue(any(p.avatar == "" for p in people))

    def test_fake_ended_and_rate_limited_rooms(self):
        from spaces_radio.fixtures import fake_fetch
        self.assertEqual(parse_crew(fake_fetch(crew_url("0000000ended", "full"), "fake"),
                                    "0000000ended", "full").state, "ended")
        with self.assertRaises(urllib.error.HTTPError) as caught:
            fake_fetch(crew_url("0000000limit", "full"), "fake")
        self.assertEqual(caught.exception.code, 429)

    def test_fake_delay_only_slows_crew_lookups(self):
        from spaces_radio.fixtures import make_fake_fetch
        from spaces_radio.sources import SEARCH_URL
        naps = []
        fetch = make_fake_fetch(0.8, sleep=naps.append)
        fetch(f"{SEARCH_URL}?query=x", "fake")
        fetch(crew_url(SID, "full"), "fake")
        self.assertEqual(naps, [0.8])


if __name__ == "__main__":
    unittest.main()
