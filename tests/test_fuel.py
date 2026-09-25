"""The fuel tank: one ledger and one answer shelf shared by every server instance."""
import tempfile
import unittest
import urllib.error
from pathlib import Path

from spaces_radio.budget import PRICE_PER_SPACE, Budget
from spaces_radio.dock import MemoryStore
from spaces_radio.fuel import SharedAnswers, SharedBudget
from spaces_radio.service import RadioService
from spaces_radio.sources import SHARED_FRESH_SECONDS, SourceError, StaleRooms, XApiSource, gather
from tests.test_radio import FakeX, x_item

ID_A, ID_B = "1YqKDqWqdPLxV", "1OwxWzqXyLbJQ"
DAY = lambda: "2026-09-25"  # noqa: E731


class Clock:
    def __init__(self):
        self.t = 5_000_000.0

    def __call__(self):
        return self.t


class SharedBudgetTests(unittest.TestCase):
    def test_two_instances_share_one_cap(self):
        store = MemoryStore()
        one = SharedBudget("bands", lambda: store, daily_cap=0.05, clock=DAY)
        two = SharedBudget("bands", lambda: store, daily_cap=0.05, clock=DAY)
        held = one.try_reserve(6)
        one.settle(held, [f"r{i}" for i in range(6)])
        self.assertAlmostEqual(two.ledger().spent, 6 * PRICE_PER_SPACE)
        self.assertIsNone(two.try_reserve(5), "the other instance sees the same tank")
        self.assertIsNotNone(two.try_reserve(4))

    def test_store_outage_keeps_counting_in_memory(self):
        class Down:
            def get(self, key):
                raise RuntimeError("down")

            def set(self, key, value, options=None):
                raise RuntimeError("down")

        b = SharedBudget("bands", lambda: Down(), daily_cap=0.02, clock=DAY)
        b.charge(["a", "b", "c", "d"])
        self.assertFalse(b.can_afford(1))


class SharedAnswerTests(unittest.TestCase):
    def setUp(self):
        self.store = MemoryStore()
        self.clock = Clock()
        self.answers = SharedAnswers(lambda: self.store, now=self.clock)

    def source(self, fake, cap=1.0):
        budget = SharedBudget("bands", lambda: self.store, daily_cap=cap, clock=DAY)
        return XApiSource("tok", budget, fetch=fake, now=self.clock, answers=self.answers)

    def test_a_word_bought_once_is_free_for_every_instance_within_the_hour(self):
        first = FakeX([x_item(ID_A, "Guitar hang", 40)])
        self.assertEqual([r.id for r in self.source(first).live("guitar")], [ID_A])
        second = FakeX([x_item(ID_B)])
        self.clock.t += SHARED_FRESH_SECONDS - 60
        self.assertEqual([r.id for r in self.source(second).live("guitar")], [ID_A])
        self.assertEqual(second.urls, [], "the second instance never asked X")
        self.clock.t += 120
        self.assertEqual([r.id for r in self.source(second).live("guitar")], [ID_B])

    def test_out_of_fuel_shows_the_last_rooms_found(self):
        self.source(FakeX([x_item(ID_A)])).live("guitar")
        self.clock.t += SHARED_FRESH_SECONDS + 1
        dry = self.source(FakeX([x_item(ID_B)]), cap=0.0)
        with self.assertRaises(StaleRooms) as stale:
            dry.live("guitar")
        self.assertEqual([r.id for r in stale.exception.spaces], [ID_A])
        self.assertIn("min ago", str(stale.exception))

    def test_x_out_of_credits_shows_the_last_rooms_and_bills_nothing(self):
        self.source(FakeX([x_item(ID_A)])).live("guitar")
        self.clock.t += SHARED_FRESH_SECONDS + 1
        broke = FakeX(error=urllib.error.HTTPError("u", 402, "Payment Required", {}, None))
        rooms, problems = gather([self.source(broke)], "guitar")
        self.assertEqual([r.id for r in rooms], [ID_A])
        self.assertIn("top up", problems[0])

    def test_no_shelf_means_a_plain_error(self):
        with self.assertRaises(SourceError):
            self.source(FakeX([x_item(ID_A)]), cap=0.0).live("jazz")


class FuelReportTests(unittest.TestCase):
    def test_report_rows_and_totals(self):
        store = MemoryStore()
        band = SharedBudget("bands", lambda: store, daily_cap=0.6, clock=DAY)
        band.charge([ID_A, ID_B])
        reply = RadioService(None, band).fuel()
        data = reply.body["data"]
        self.assertEqual((reply.status, reply.cdn_seconds), (200, 0))
        self.assertEqual(data["rows"][0]["key"], "bands")
        self.assertAlmostEqual(data["spent"], 2 * PRICE_PER_SPACE)
        self.assertEqual((data["cap"], data["shared"]), (0.6, True))
        with tempfile.TemporaryDirectory() as tmp:
            local = Budget(Path(tmp) / "b.json", 0.6, clock=DAY)
            self.assertFalse(RadioService(None, local).fuel().body["data"]["shared"])


if __name__ == "__main__":
    unittest.main()
