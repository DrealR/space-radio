"""What a listener notices after the mending: the crew button works for every room the
dial shows, and a room that got in through the dial is always answered with the whole
crew, whoever asked first. No network: X is a fake that records its calls."""
import threading
import unittest

from spaces_radio.budget import PRICE_PER_SPACE, PRICE_PER_USER, Budget
from spaces_radio.crew import CrewLookup, valid_crew_id
from spaces_radio.crew_parse import CREW_ID
from spaces_radio.service import RadioService
from tests.test_crew import DAY, SID, FakeCrewX, crew_body, query_of
from tests.test_radio import Clock, TmpCase

LONG_ID = "1YqKDqWqdPLxVabc"     # 16 characters, a length the dial takes
WIDEST_ID = "1YqKDqWqdPLxVabcdefg"    # 20 characters: the longest room id there is
TOO_WIDE = WIDEST_ID + "h"           # 21: not a room id anywhere


class GateX(FakeCrewX):
    """The probe answers at once; a host-only named lookup waits for the test's gate."""

    def __init__(self, body, gate):
        super().__init__(body)
        self.gate, self.naming = gate, threading.Event()

    def __call__(self, url, token):
        if query_of(url).get("expansions") == "creator_id":
            self.naming.set()
            self.gate.wait(5)
        return super().__call__(url, token)


class TrustedAfterHostOnlyTests(TmpCase):
    def make(self, fake, crew_cap=0.5, space_cap=1.0, **extra):
        self.clock = Clock()
        self.spaces = Budget(self.dir / "s.json", daily_cap=space_cap, clock=lambda: DAY)
        self.users = Budget(self.dir / "u.json", daily_cap=crew_cap, clock=lambda: DAY, price=PRICE_PER_USER)
        return CrewLookup("tok", self.spaces, self.users, fetch=fake, now=self.clock,
                          log=lambda line: None, **extra)

    def test_a_listener_who_got_the_room_from_the_dial_still_gets_the_whole_crew(self):
        fake = FakeCrewX(crew_body())
        crew = self.make(fake)
        first, cached = crew.scan(SID, trusted=False)  # a preset, a pasted link, a script
        self.assertEqual((first.mode, cached, len(first.crew)), ("host-only", False, 1))
        scan, cached = crew.scan(SID, trusted=True)   # the dial's own room, ticket and all
        self.assertEqual((scan.mode, cached, len(scan.crew)), ("full", False, 3))
        # A probe, the host-only lookup, then exactly what a fresh full scan spends: a probe
        # and every name (X bills names again on every scan, so three, not one).
        self.assertEqual([query_of(u).get("expansions", "") for u in fake.urls],
                         ["", "creator_id", "", "creator_id,host_ids,speaker_ids"])
        self.assertAlmostEqual(self.users.ledger().spent, 4 * PRICE_PER_USER)
        self.assertAlmostEqual(self.spaces.ledger().spent, 4 * PRICE_PER_SPACE)

    def test_the_full_roster_replaces_the_host_only_one_in_the_cache(self):
        crew = self.make(FakeCrewX(crew_body()))
        crew.scan(SID, trusted=False)
        crew.scan(SID, trusted=True)
        self.assertTrue(crew.scan(SID, trusted=True)[1])
        for trusted in (True, False):  # everyone after that is served the paid-for roster
            scan, cached = crew.scan(SID, trusted=trusted)
            self.assertEqual((scan.mode, cached, len(scan.crew)), ("full", True, 3), trusted)

    def test_an_untrusted_request_after_a_host_only_scan_spends_nothing(self):
        fake = FakeCrewX(crew_body())
        crew = self.make(fake)
        crew.scan(SID, trusted=False)
        names, rooms = self.users.ledger().spent, self.spaces.ledger().spent
        scan, cached = crew.scan(SID, trusted=False)
        self.assertEqual((scan.mode, cached, len(fake.urls)), ("host-only", True, 2))
        self.assertEqual((self.users.ledger().spent, self.spaces.ledger().spent), (names, rooms))

    def test_a_cached_full_roster_is_still_shared_with_everyone(self):
        fake = FakeCrewX(crew_body())
        crew = self.make(fake)
        crew.scan(SID, trusted=True)
        scan, cached = crew.scan(SID, trusted=False)  # a pasted link, no ticket
        self.assertEqual((scan.mode, cached, len(scan.crew)), ("full", True, 3))
        self.assertEqual(len(fake.urls), 2)

    def test_a_host_only_roster_the_ledger_could_not_buy_is_cached_all_the_same(self):
        # 3 names plus a margin don't fit in a $0.05 day: buying again would spend for nothing.
        fake = FakeCrewX(crew_body())
        crew = self.make(fake, crew_cap=0.05)
        self.assertEqual(crew.scan(SID, trusted=True)[0].mode, "host-only")
        names, rooms = self.users.ledger().spent, self.spaces.ledger().spent
        scan, cached = crew.scan(SID, trusted=True)
        self.assertEqual((scan.mode, cached, len(fake.urls)), ("host-only", True, 2))
        self.assertEqual((self.users.ledger().spent, self.spaces.ledger().spent), (names, rooms))

    def test_a_trusted_request_waits_out_a_host_only_scan_and_still_gets_the_whole_crew(self):
        gate = threading.Event()
        fake = GateX(crew_body(), gate)
        crew = self.make(fake)
        answers = {}
        threads = [threading.Thread(target=lambda k=k: answers.__setitem__(k, crew.scan(SID, trusted=k)))
                   for k in (False, True)]
        threads[0].start()
        self.assertTrue(fake.naming.wait(5), "the host-only lookup never reached X")
        threads[1].start()
        gate.set()
        for thread in threads:
            thread.join(10)
        self.assertEqual(answers[False][0].mode, "host-only")
        self.assertEqual((answers[True][0].mode, len(answers[True][0].crew)), ("full", 3))


class HeldScanTests(TmpCase):
    """A listener who got the room from the dial and cannot start a scan of its own (X is
    holding the whole app, or the day's names are spent) gets the host the room already
    has, not an error: the host is better than nothing."""

    def make(self, fake, crew_cap=0.5, space_cap=1.0):
        self.clock = Clock()
        self.spaces = Budget(self.dir / "s.json", daily_cap=space_cap, clock=lambda: DAY)
        self.users = Budget(self.dir / "u.json", daily_cap=crew_cap, clock=lambda: DAY, price=PRICE_PER_USER)
        return CrewLookup("tok", self.spaces, self.users, fetch=fake, now=self.clock,
                          log=lambda line: None)

    def test_a_held_app_serves_the_cached_host_to_a_ticketed_listener(self):
        fake = FakeCrewX(crew_body())
        crew = self.make(fake)
        crew.scan(SID, trusted=False)          # a preset, a pasted link: the host is cached
        crew._hold_after("credits")            # X refused the whole app for a while
        names, rooms = self.users.ledger().spent, self.spaces.ledger().spent
        scan, cached = crew.scan(SID, trusted=True)   # the dial's own room, ticket and all
        self.assertEqual((scan.mode, cached, len(scan.crew)), ("host-only", True, 1))
        self.assertEqual(len(fake.urls), 2)
        self.assertEqual((self.users.ledger().spent, self.spaces.ledger().spent), (names, rooms))

    def test_a_spent_names_cap_serves_the_cached_host_to_a_ticketed_listener(self):
        fake = FakeCrewX(crew_body())
        crew = self.make(fake, crew_cap=0.05)
        crew.scan(SID, trusted=False)
        self.users.charge([f"earlier-{i}" for i in range(4)])   # the day's names are spent
        spent, rooms = self.users.ledger().spent, self.spaces.ledger().spent
        scan, cached = crew.scan(SID, trusted=True)
        self.assertEqual((scan.mode, cached, len(scan.crew)), ("host-only", True, 1))
        self.assertEqual(len(fake.urls), 2)
        self.assertEqual((self.users.ledger().spent, self.spaces.ledger().spent), (spent, rooms))


class RoomIdTests(TmpCase):
    def service(self, fake):
        spaces = Budget(self.dir / "s.json", daily_cap=1.0, clock=lambda: DAY)
        users = Budget(self.dir / "u.json", daily_cap=0.5, clock=lambda: DAY, price=PRICE_PER_USER)
        return RadioService(None, spaces, CrewLookup("tok", spaces, users, fetch=fake, log=lambda line: None))

    def test_the_crew_takes_every_room_id_the_dial_shows(self):
        for sid in ("12345678", SID, LONG_ID, WIDEST_ID):
            self.assertEqual(valid_crew_id(sid), sid)
            self.assertTrue(CREW_ID.fullmatch(sid), sid)
        for junk in ("1234567", TOO_WIDE, f"https://x.com/i/spaces/{SID}", SID + "\n", None, 12345678):
            self.assertIsNone(valid_crew_id(junk), junk)

    def test_a_long_room_id_the_dial_serves_can_still_be_scanned(self):
        svc = self.service(FakeCrewX(crew_body(LONG_ID)))
        reply = svc.crew_raw(f"id={LONG_ID}")
        self.assertEqual((reply.status, reply.body["data"]["id"]), (200, LONG_ID))
        self.assertEqual(reply.body["meta"]["mode"], "full")
        self.assertIsNone(svc.crew_raw(f"id={TOO_WIDE}").body["data"])


if __name__ == "__main__":
    unittest.main()
