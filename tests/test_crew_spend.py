"""What names cost, under pressure: concurrent scans, reservations, probes and tickets.
No network: X is a fake that records its calls."""
import contextlib
import io
import json
import threading
import time
import unittest
from urllib.parse import urlsplit

from spaces_radio.budget import PRICE_PER_SPACE, PRICE_PER_USER, Budget
from spaces_radio.crew import CrewError, CrewLookup
from spaces_radio.service import RadioService
from spaces_radio.sources import XApiSource
from spaces_radio.ticket import TICKET_SECONDS, Tickets, ticket_key
from tests.test_crew import DAY, ID_B, SID, FakeCrewX, as_x_would, crew_body, http_error, query_of, user
from tests.test_radio import Clock, TmpCase, x_item

ROOM_IDS = [f"1Room{i:08d}" for i in range(24)]


def room_of(url):
    return urlsplit(url).path.rsplit("/", 1)[-1]


class RoomsX:
    """Every room has its own nine people. Thread-safe; can pause to let requests pile up."""

    def __init__(self, delay=0.0, fail_names=False):
        self.delay, self.fail_names, self.urls = delay, fail_names, []
        self._lock = threading.Lock()

    def __call__(self, url, token):
        with self._lock:
            self.urls = [*self.urls, url]
        if self.delay:
            time.sleep(self.delay)
        if self.fail_names and query_of(url).get("expansions"):
            raise TimeoutError("slow")
        sid = room_of(url)
        base = 10_000 * (ROOM_IDS.index(sid) + 1 if sid in ROOM_IDS else 99)
        ids = [str(base + k) for k in range(9)]
        body = crew_body(space_id=sid, users=[user(i, f"u{i}") for i in ids],
                         creator_id=ids[0], host_ids=ids[:3], speaker_ids=ids[2:])
        return as_x_would(body, url)


def quiet_lookup(case, fake, crew_cap=0.5, space_cap=1.0, **extra):
    case.spaces = Budget(case.dir / "s.json", daily_cap=space_cap, clock=lambda: DAY)
    case.users = Budget(case.dir / "u.json", daily_cap=crew_cap, clock=lambda: DAY, price=PRICE_PER_USER)
    return CrewLookup("tok", case.spaces, case.users, fetch=fake, log=lambda line: None, **extra)


def run_together(count, work):
    """Start `count` threads at once; returns what each returned or raised."""
    results = [None] * count
    gate = threading.Barrier(count)

    def one(k):
        gate.wait()
        try:
            results[k] = work(k)
        except Exception as err:  # noqa: BLE001 - the test inspects it
            results[k] = err
    threads = [threading.Thread(target=one, args=(k,)) for k in range(count)]
    [t.start() for t in threads]
    [t.join(10) for t in threads]
    return results


class BudgetReservationTests(TmpCase):
    def budget(self, cap=0.05):
        return Budget(self.dir / "u.json", daily_cap=cap, clock=lambda: DAY, price=PRICE_PER_USER)

    def test_reserve_settle_release(self):
        b = self.budget()
        held = b.try_reserve(4, tag="r")
        self.assertEqual(len(held), 4)
        self.assertAlmostEqual(b.ledger().spent, 0.04)
        self.assertIsNone(b.try_reserve(2))  # would pass the cap: nothing held
        self.assertAlmostEqual(b.ledger().spent, 0.04)
        b.settle(held, ["1", "2"])
        self.assertEqual(b.ledger().paid_ids, frozenset({"1", "2"}))
        again = b.try_reserve(3)
        b.release(again)
        self.assertAlmostEqual(b.ledger().spent, 0.02)

    def test_file_is_replaced_whole(self):
        b = self.budget(cap=5)
        run_together(16, lambda k: b.charge([f"id{k}"]))
        saved = json.loads((self.dir / "u.json").read_text())
        self.assertEqual(len(saved["paid_ids"]), 16)
        self.assertEqual([p.name for p in self.dir.iterdir()], ["u.json"])  # no temp files left behind


class ConcurrentCrewTests(TmpCase):
    def test_many_rooms_at_once_never_pass_the_cap(self):
        crew = quiet_lookup(self, RoomsX(delay=0.02), crew_cap=0.5, max_calls_per_minute=500)
        results = run_together(len(ROOM_IDS), lambda k: crew.scan(ROOM_IDS[k]))
        self.assertLessEqual(self.users.ledger().spent, 0.5 + 1e-9)
        json.loads((self.dir / "u.json").read_text())  # still readable
        answered = [r for r in results if isinstance(r, tuple)]
        self.assertTrue(answered)
        self.assertTrue(all(isinstance(r, (tuple, CrewError)) for r in results))
        self.assertTrue(any(scan.mode == "full" for scan, _ in answered))

    def test_one_room_asked_for_at_once_is_scanned_once(self):
        fake = RoomsX(delay=0.05)
        crew = quiet_lookup(self, fake)
        results = run_together(10, lambda k: crew.scan(ROOM_IDS[0]))
        self.assertEqual(len(fake.urls), 2)  # one probe, one named lookup
        self.assertEqual(len({id(scan) for scan, _ in results}), 1)
        self.assertEqual(sorted(cached for _, cached in results), [False] + [True] * 9)

    def test_a_failed_lookup_gives_its_reservation_back(self):
        crew = quiet_lookup(self, RoomsX(fail_names=True))
        with self.assertRaises(CrewError) as caught:
            crew.scan(ROOM_IDS[0])
        self.assertEqual(caught.exception.reason, "offline")
        self.assertEqual(self.users.ledger().spent, 0)
        self.assertAlmostEqual(self.spaces.ledger().spent, PRICE_PER_SPACE)  # the probe came back: X billed it


class ProbeTests(TmpCase):
    def test_rooms_that_are_not_live_never_pay_for_names(self):
        for state in ("scheduled", "ended"):
            fake = FakeCrewX(crew_body(state=state))
            scan, _ = quiet_lookup(self, fake).scan(SID)
            self.assertEqual((scan.state, scan.crew), (state, ()))
            self.assertEqual(len(fake.urls), 1)
            self.assertNotIn("expansions", query_of(fake.urls[0]))
            self.assertEqual(self.users.ledger().spent, 0)

    def test_a_crowd_on_the_mic_is_priced_before_names_are_bought(self):
        speakers = [str(100 + i) for i in range(40)]
        crowd = [user("1", "captain")] + [user(i, f"s{i}") for i in speakers]
        fake = FakeCrewX(crew_body(users=crowd, speaker_ids=speakers))
        crew = quiet_lookup(self, fake)
        self.users.charge([f"earlier-{i}" for i in range(35)])  # $0.35 of $0.50 already spent
        scan, _ = crew.scan(SID)
        self.assertEqual(scan.mode, "host-only")
        self.assertLessEqual(self.users.ledger().spent, 0.36 + 1e-9)

    def test_no_ticket_means_the_host_at_most(self):
        fake = FakeCrewX(crew_body())
        scan, _ = quiet_lookup(self, fake).scan(SID, trusted=False)
        self.assertEqual(([p.role for p in scan.crew], scan.mode), (["host"], "host-only"))
        self.assertEqual(query_of(fake.urls[-1])["expansions"], "creator_id")

    def test_a_cached_roster_is_served_while_x_is_refusing(self):
        fake = FakeCrewX(crew_body())
        crew = quiet_lookup(self, fake)
        crew.scan(SID)
        fake.error = http_error(429)
        with self.assertRaises(CrewError):
            crew.scan(ID_B)
        self.assertEqual(crew.scan(SID)[1], True)


class CrewSpaceLedgerTests(TmpCase):
    def make(self, fake, space_cap=0.10):
        clock = lambda: DAY  # noqa: E731
        self.band = Budget(self.dir / "b.json", daily_cap=0.50, clock=clock)
        self.spaces = Budget(self.dir / "s.json", daily_cap=space_cap, clock=clock)
        self.users = Budget(self.dir / "u.json", daily_cap=0.5, clock=clock, price=PRICE_PER_USER)
        return CrewLookup("tok", self.spaces, self.users, fetch=fake, log=lambda line: None, band_budget=self.band)

    def test_names_never_touch_the_dials_ledger(self):
        crew = self.make(FakeCrewX(crew_body()))
        self.band.charge([f"room{i}" for i in range(90)])  # $0.45 of $0.50
        crew.scan(SID)
        self.assertTrue(self.band.can_afford(10))
        self.assertAlmostEqual(self.spaces.ledger().spent, PRICE_PER_SPACE)

    def test_a_spent_space_cap_refuses_new_rooms_without_calling_x(self):
        fake = FakeCrewX(crew_body())
        crew = self.make(fake, space_cap=0.0)
        with self.assertRaises(CrewError) as caught:
            crew.scan(SID)
        self.assertEqual((caught.exception.reason, fake.urls), ("budget", []))

    def test_a_room_the_dial_already_paid_for_still_scans(self):
        crew = self.make(FakeCrewX(crew_body()), space_cap=0.0)
        self.band.charge([SID])
        self.assertEqual(crew.scan(SID)[0].mode, "full")
        self.assertEqual(self.spaces.ledger().spent, 0)


class BandReservationTests(TmpCase):
    def test_searches_at_once_never_pass_the_cap(self):
        lock = threading.Lock()
        made = []

        def fake(url, token):
            with lock:
                made.append(url)
                n = len(made)
            time.sleep(0.02)
            return {"data": [x_item(f"1Band{n:03d}{k:05d}") for k in range(10)]}
        budget = Budget(self.dir / "b.json", daily_cap=0.20, clock=lambda: DAY)
        src = XApiSource("tok", budget, max_results=10, fetch=fake, now=Clock())
        run_together(12, lambda k: src.live(f"topic{k}"))
        self.assertLessEqual(budget.ledger().spent, 0.20 + 1e-9)
        self.assertLessEqual(len(made), 4)

    def test_a_failed_search_gives_its_reservation_back(self):
        def fake(url, token):
            raise TimeoutError("slow")
        budget = Budget(self.dir / "b.json", clock=lambda: DAY)
        with self.assertRaises(Exception):
            XApiSource("tok", budget, fetch=fake).live("music")
        self.assertEqual(budget.ledger().spent, 0)


class TicketTests(TmpCase):
    def test_same_for_everyone_in_a_window_and_good_for_the_next(self):
        clock = Clock(t=10 * TICKET_SECONDS + 5)
        tickets = Tickets(b"k", now=clock)
        first = tickets.issue(SID)
        self.assertEqual(first, tickets.issue(SID))
        self.assertNotEqual(first, tickets.issue(ID_B))
        clock.t += TICKET_SECONDS
        self.assertTrue(tickets.valid(SID, first))
        clock.t += TICKET_SECONDS
        self.assertFalse(tickets.valid(SID, first))
        for junk in (None, "", "XYZ", first.upper(), first + "0"):
            self.assertFalse(tickets.valid(SID, junk))

    def test_key_comes_from_the_environment_or_the_x_key(self):
        self.assertEqual(ticket_key({"SPACES_RADIO_TICKET_KEY": " s "}, "tok"), b"s")
        derived = ticket_key({}, "tok")
        self.assertTrue(derived and b"tok" not in derived)
        self.assertIsNone(ticket_key({}, ""))

    def service(self, fake):
        band = Budget(self.dir / "b.json", clock=lambda: DAY)
        crew = quiet_lookup(self, fake)
        source = XApiSource("tok", band, fetch=lambda url, token: {"data": [x_item(SID)]})
        return RadioService(source, band, crew, Tickets(b"k"))

    def test_tuned_rooms_carry_a_ticket_that_buys_the_whole_crew(self):
        svc = self.service(FakeCrewX(crew_body()))
        room = svc.tune({"station": ["music"]}).body["data"][0]
        with contextlib.redirect_stderr(io.StringIO()):
            full = svc.crew_raw(f"id={SID}&t={room['ticket']}")
        self.assertEqual(full.body["meta"]["mode"], "full")
        other = self.service(FakeCrewX(crew_body()))
        self.assertEqual(other.crew({"id": [SID], "t": ["0" * 16]}).body["meta"]["mode"], "host-only")


class RawQueryTests(TmpCase):
    def service(self):
        band = Budget(self.dir / "b.json", clock=lambda: DAY)
        source = XApiSource("tok", band, fetch=lambda url, token: {"data": [x_item(SID)]})
        return RadioService(source, band, quiet_lookup(self, FakeCrewX(crew_body())))

    def test_only_one_spelling_of_a_crew_request(self):
        svc = self.service()
        for raw in (f"id={SID}&", f"&id={SID}", f"%69d={SID}", f"id=%31{SID[1:]}", f"id={SID}&t=",
                    f"id={SID}&t=ABCDEF0123456789", f"t={'a' * 16}&id={SID}", ""):
            reply = svc.crew_raw(raw)
            self.assertEqual((reply.status, reply.body["meta"]["reason"], reply.cdn_seconds),
                             (400, "bad-request", 0), raw)
        self.assertEqual(svc.crew_raw(f"id={SID}").status, 200)
        self.assertEqual(svc.crew_raw(f"id={SID}&t={'a' * 16}").status, 200)

    def test_only_one_spelling_of_a_band(self):
        svc = self.service()
        for raw in ("station=music&&", "station=%6dusic", "station=late+night", "", "station=music&x=1"):
            self.assertEqual(svc.tune_raw(raw).status, 400, raw)
        self.assertEqual(svc.tune_raw("station=late%20night").status, 200)
        self.assertEqual(svc.tune_raw("station=music").status, 200)


if __name__ == "__main__":
    unittest.main()
