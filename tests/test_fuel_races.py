"""Money under pressure (Sep 28, from the Sky Survey): instances that write the tank at once,
a store that refuses writes, two searches for one word, and rooms X bills that the dial drops.
No network: X is a fake that records its calls; the store is the in-memory twin of Vercel's."""
import contextlib
import io
import json
import threading
import time
import unittest

from spaces_radio.budget import PRICE_PER_SPACE, PRICE_PER_USER, Budget
from spaces_radio.crew import CrewError, CrewLookup
from spaces_radio.dock import MemoryStore
from spaces_radio.fuel import SharedAnswers, SharedBudget
from spaces_radio.service import RadioService
from spaces_radio.space import Space
from spaces_radio.sources import SHARED_FRESH_SECONDS, SourceError, XApiSource
from tests.test_crew import SID, FakeCrewX, crew_body
from tests.test_crew_spend import run_together
from tests.test_fuel import DAY, ID_A, ID_B, Clock
from tests.test_radio import FakeX, TmpCase, x_item

NO_PAUSE = lambda seconds: None  # noqa: E731


def x_space(space_id):
    return Space(id=space_id, title="Room", listeners=5, speakers=1, hosts=1, started_at="", lang="",
                 topic="guitar", source="x-api")


class FallsBehind:
    """One instance's view of the store. After `fall_behind()`, its reads return what the store
    held at that moment until this instance writes: it read just before another instance wrote."""

    def __init__(self, store):
        self.store, self.snapshot = store, None

    def fall_behind(self):
        self.snapshot = {k: self.store.get(k) for k in list(self.store._items)}

    def get(self, key):
        return self.store.get(key) if self.snapshot is None else self.snapshot.get(key)

    def set(self, key, value, options=None):
        self.snapshot = None
        self.store.set(key, value, options)


class RefusesWrites:
    """Reads work; every write fails."""

    def __init__(self, store):
        self.store = store

    def get(self, key):
        return self.store.get(key)

    def set(self, key, value, options=None):
        raise RuntimeError("the cache refused the write")


class ReadsFail:
    """Writes work; reads fail once `down` is set."""

    def __init__(self, store):
        self.store, self.down = store, False

    def get(self, key):
        if self.down:
            raise RuntimeError("the cache timed out")
        return self.store.get(key)

    def set(self, key, value, options=None):
        self.store.set(key, value, options)


class MeetFirst:
    """The first read by each of `parties` worker threads waits for the others: they all read one
    tank. The thread that builds the instances reads freely."""

    def __init__(self, store, parties):
        self.store, self.gate, self.seen = store, threading.Barrier(parties), {threading.get_ident()}
        self.met = 0
        self._lock = threading.Lock()

    def get(self, key):
        value = self.store.get(key)
        with self._lock:
            first = threading.get_ident() not in self.seen
            self.seen = self.seen | {threading.get_ident()}
        if first:
            self.gate.wait(5)
            with self._lock:
                self.met += 1
        return value

    def set(self, key, value, options=None):
        self.store.set(key, value, options)


def tank(store, cap=0.60, pause=NO_PAUSE):
    return SharedBudget("bands", lambda: store, daily_cap=cap, clock=DAY, pause=pause)


class TankRaceTests(unittest.TestCase):
    def test_a_write_that_lands_on_another_loses_neither_record(self):
        store = MemoryStore()
        one, view = tank(store), FallsBehind(store)
        two = tank(view)
        view.fall_behind()                       # two reads the empty tank...
        one.charge([ID_A])                       # ...one records a room...
        two.charge([ID_A])                       # ...and two's write lands on top of it
        one.ledger()                             # one looks again: its record goes back in
        self.assertAlmostEqual(tank(store).ledger().spent, 2 * PRICE_PER_SPACE,
                               msg="both calls billed the room; both records survive")

    def test_a_failed_write_never_hands_spent_fuel_back(self):
        store = MemoryStore()
        tank(store).charge([ID_A])               # the store holds one room
        with contextlib.redirect_stderr(io.StringIO()):
            flaky = tank(RefusesWrites(store))
            self.assertIsNotNone(flaky.try_reserve(119))   # $0.60 held, but only in memory
            self.assertIsNone(flaky.try_reserve(119), "an older stored tank must not reopen spending")
            self.assertFalse(flaky.can_afford(1))

    def race(self, rooms):
        store = MemoryStore()
        meet = MeetFirst(store, 2)
        tanks = [tank(meet, pause=time.sleep), tank(meet, pause=time.sleep)]
        results = run_together(2, lambda k: ("done", tanks[k].try_reserve(rooms)))
        self.assertEqual(meet.met, 2, "both instances read the same tank before either wrote")
        self.assertEqual([r[0] for r in results], ["done", "done"])
        return store, [held for _, held in results if held]

    def test_two_instances_reserving_the_last_fuel_at_once_never_pass_the_cap(self):
        store, granted = self.race(80)
        self.assertLessEqual(len(granted), 1, "80 + 80 rooms can't both fit under 120")
        self.assertLessEqual(tank(store).ledger().spent, 0.60 + 1e-9)

    def test_two_instances_that_both_fit_both_get_their_fuel(self):
        store, granted = self.race(40)
        self.assertEqual(len(granted), 2)
        self.assertAlmostEqual(tank(store).ledger().spent, 80 * PRICE_PER_SPACE)

    def test_a_charge_covered_up_during_its_second_look_is_put_back(self):
        store = MemoryStore()
        view = FallsBehind(store)
        two = tank(view)
        view.fall_behind()                       # two read the empty tank before one wrote
        one = tank(store, pause=lambda seconds: two.charge([ID_B]))  # ...and writes during one's beat
        one.charge([ID_A])
        self.assertAlmostEqual(tank(store).ledger().spent, 2 * PRICE_PER_SPACE,
                               msg="one never has to come back for its record to survive")

    def test_a_failed_read_never_overwrites_the_tank(self):
        store = MemoryStore()
        tank(store).charge([f"r{i}" for i in range(20)])       # another instance: $0.10
        blind = ReadsFail(store)
        three = tank(blind)
        blind.down = True
        with contextlib.redirect_stderr(io.StringIO()):
            three.ledger()
            three.can_afford(1)
            self.assertIsNone(three.try_reserve(1), "no fuel while the tank can't be read")
        self.assertAlmostEqual(tank(store).ledger().spent, 20 * PRICE_PER_SPACE)

    def test_calls_that_cost_nothing_keep_the_tank_small(self):
        store = MemoryStore()
        budget = tank(store)
        for _ in range(500):
            budget.settle(budget.try_reserve(10), [])   # a search that found no rooms: $0
        stored = store.get(f"fuel-bands-{DAY()}")
        self.assertEqual((budget.ledger().spent, budget.ledger().calls), (0, 500))
        self.assertLess(len(json.dumps(stored)), 400)

    def test_a_tank_from_the_previous_version_still_counts(self):
        store = MemoryStore()
        store.set(f"fuel-bands-{DAY()}", {"paid_ids": ["0:a", "0:b"], "calls": 1}, {"ttl": 60})
        led = tank(store).ledger()
        self.assertEqual((led.spent, led.calls), (2 * PRICE_PER_SPACE, 1))
        tank(store).charge(["c"])
        self.assertEqual(store.get(f"fuel-bands-{DAY()}")["calls"], 2, "old readers still get a count")


class OneWordOnceTests(unittest.TestCase):
    def slow_x(self, delay=0.1):
        calls = []
        lock = threading.Lock()

        def fake(url, token):
            with lock:
                calls.append(url)
            time.sleep(delay)
            return {"data": [x_item(ID_A, "Guitar hang", 40)]}
        return fake, calls

    def test_one_word_asked_for_at_once_is_searched_once(self):
        fake, calls = self.slow_x()
        src = XApiSource("tok", tank(MemoryStore(), cap=1.0), fetch=fake, now=Clock())
        results = run_together(6, lambda k: src.live("guitar"))
        self.assertEqual(len(calls), 1)
        self.assertEqual([[r.id for r in rooms] for rooms in results], [[ID_A]] * 6)

    def test_two_instances_asking_one_word_at_once_search_once(self):
        store, clock = MemoryStore(), Clock()
        fake, calls = self.slow_x()

        def instance():
            answers = SharedAnswers(lambda: store, now=clock, pause=time.sleep)
            return XApiSource("tok", tank(store, cap=1.0), fetch=fake, now=clock, answers=answers)
        radios = [instance(), instance()]
        results = run_together(2, lambda k: radios[k].live("guitar"))
        self.assertEqual(len(calls), 1, "the second instance waits for the first one's answer")
        self.assertEqual([[r.id for r in rooms] for rooms in results], [[ID_A]] * 2)
        self.assertAlmostEqual(tank(store).ledger().spent, PRICE_PER_SPACE)

    def test_a_radio_arriving_while_another_buys_waits_for_its_answer(self):
        store, clock = MemoryStore(), Clock()
        fake, calls = self.slow_x(delay=0.3)

        def instance():
            answers = SharedAnswers(lambda: store, now=clock, pause=time.sleep)
            return XApiSource("tok", tank(store, cap=1.0), fetch=fake, now=clock, answers=answers)
        first, second = instance(), instance()
        early = threading.Thread(target=first.live, args=("guitar",))
        early.start()
        time.sleep(0.2)                               # first holds the lease and is asking X
        self.assertEqual([r.id for r in second.live("guitar")], [ID_A])
        early.join(5)
        self.assertEqual(len(calls), 1)

    def test_an_answer_shelved_while_claiming_is_used_not_bought_again(self):
        store, clock = MemoryStore(), Clock()
        other = SharedAnswers(lambda: store, now=clock, pause=NO_PAUSE)
        shelved = lambda seconds: other.put("guitar", [x_space(ID_B)])  # noqa: E731
        answers = SharedAnswers(lambda: store, now=clock, pause=shelved)
        fake = FakeX([x_item(ID_A)])
        src = XApiSource("tok", tank(store, cap=1.0), fetch=fake, now=clock, answers=answers)
        self.assertEqual([r.id for r in src.live("guitar")], [ID_B])
        self.assertEqual(fake.urls, [])

    def another_instance_holds(self, store, clock, word):
        lease_key = SharedAnswers._key(word, "lease")
        store.set(lease_key, {"owner": "0ther.1", "until": clock() + 15}, {"ttl": 15})
        return lease_key

    def test_a_word_still_being_bought_elsewhere_is_never_bought_twice(self):
        store, clock = MemoryStore(), Clock()
        self.another_instance_holds(store, clock, "guitar")
        fake = FakeX([x_item(ID_A)])
        answers = SharedAnswers(lambda: store, now=clock, pause=NO_PAUSE)
        src = XApiSource("tok", tank(store, cap=1.0), fetch=fake, now=clock, answers=answers)
        with self.assertRaises(SourceError) as caught:
            src.live("guitar")
        self.assertIn("Another radio", str(caught.exception))
        self.assertEqual((fake.urls, tank(store).ledger().spent), ([], 0))

    def test_when_the_other_instance_gives_up_the_waiting_one_tries_itself(self):
        store, clock = MemoryStore(), Clock()
        lease_key = self.another_instance_holds(store, clock, "guitar")
        pauses = []

        def gives_up(seconds):  # the other instance lets go during our first wait
            if not pauses:
                store.set(lease_key, {"owner": "0ther.1", "until": 0}, {"ttl": 15})
            pauses.append(seconds)
        fake = FakeX([x_item(ID_A)])
        answers = SharedAnswers(lambda: store, now=clock, pause=gives_up)
        src = XApiSource("tok", tank(store, cap=1.0), fetch=fake, now=clock, answers=answers)
        self.assertEqual([r.id for r in src.live("guitar")], [ID_A])
        self.assertEqual(len(fake.urls), 1)


class BilledRoomTests(TmpCase):
    def test_rooms_the_dial_drops_are_still_billed(self):
        items = [x_item(ID_A), x_item(ID_B, is_ticketed=True), x_item("1OdKrjRmVNnGX", state="ended"),
                 {"id": "not a space id", "title": "junk"}]
        budget = Budget(self.dir / "b.json", clock=DAY)
        rooms = XApiSource("tok", budget, fetch=FakeX(items)).live("music")
        self.assertEqual([r.id for r in rooms], [ID_A])
        self.assertAlmostEqual(budget.ledger().spent, 4 * PRICE_PER_SPACE, msg="X returned four rooms")

    def crew(self, space_cap=1.0):
        self.spaces = Budget(self.dir / "s.json", daily_cap=space_cap, clock=DAY)
        self.users = Budget(self.dir / "u.json", daily_cap=0.5, clock=DAY, price=PRICE_PER_USER)
        self.fake = FakeCrewX(crew_body())
        return CrewLookup("tok", self.spaces, self.users, fetch=self.fake, log=lambda line: None)

    def test_the_named_lookup_pays_for_its_space_read_too(self):
        self.crew().scan(SID)
        self.assertEqual(len(self.fake.urls), 2)
        self.assertAlmostEqual(self.spaces.ledger().spent, 2 * PRICE_PER_SPACE,
                               msg="the probe and the named lookup each return the Space")

    def test_no_fuel_for_the_second_space_read_means_no_names(self):
        crew = self.crew(space_cap=PRICE_PER_SPACE)   # room for the probe only
        with self.assertRaises(CrewError) as caught:
            crew.scan(SID)
        self.assertEqual((caught.exception.reason, len(self.fake.urls)), ("budget", 1))
        self.assertEqual(self.users.ledger().spent, 0, "the names' hold was given back")


class StaleSearchTests(unittest.TestCase):
    def test_a_band_you_made_shows_the_last_rooms_when_fuel_runs_out(self):
        store, clock = MemoryStore(), Clock()
        answers = SharedAnswers(lambda: store, now=clock, pause=NO_PAUSE)
        XApiSource("tok", tank(store, cap=1.0), fetch=FakeX([x_item(ID_A)]), now=clock, answers=answers).live("jazz")
        clock.t += SHARED_FRESH_SECONDS + 1
        dry = XApiSource("tok", tank(store, cap=0.0), fetch=FakeX([x_item(ID_B)]), now=clock, answers=answers)
        reply = RadioService(dry, dry._budget).search_raw("q=jazz")
        self.assertEqual(reply.status, 200)
        self.assertEqual([r["id"] for r in reply.body["data"]], [ID_A])
        self.assertIn("min ago", reply.body["meta"]["problems"][0])


if __name__ == "__main__":
    unittest.main()
