"""Finding #5, Reemy's call (Oct 1): a band X had nothing live for is remembered for an hour,
so a quiet band stops costing a paid search every few minutes. A band with rooms keeps its rule.
No network and no key: X is a fake that counts the searches it is asked for."""
import tempfile
import unittest
from pathlib import Path

from spaces_radio.budget import Budget
from spaces_radio.dock import MemoryStore
from spaces_radio.fuel import SharedAnswers, SharedBudget
from spaces_radio.service import FRESH_SECONDS, RadioService
from spaces_radio.sources import EMPTY_BAND_SECONDS, XApiSource
from tests.test_radio import Clock, x_item

DAY = "2026-10-01"
MINUTE = 60
NO_PAUSE = lambda seconds: None  # noqa: E731


class CountingX:
    """Stands in for X: records every search and answers with `items`."""

    def __init__(self, items=()):
        self.items, self.urls = list(items), []

    def __call__(self, url, token):
        self.urls.append(url)
        return {"data": self.items}


def source(fetch, clock, store=None):
    """One instance. With a store it shares the hour's answers and the day's tank, as on Vercel;
    without one it stands alone, as on a laptop."""
    if store is None:
        tank = Budget(Path(tempfile.mkdtemp()) / "b.json", clock=lambda: DAY)
        return XApiSource("tok", tank, fetch=fetch, now=clock)
    tank = SharedBudget("bands", lambda: store, daily_cap=5.0, clock=lambda: DAY, pause=NO_PAUSE)
    shelf = SharedAnswers(lambda: store, now=clock, pause=NO_PAUSE)
    return XApiSource("tok", tank, fetch=fetch, now=clock, answers=shelf)


class EmptyBandHourTests(unittest.TestCase):
    def test_the_hour_is_one_named_hour(self):
        self.assertEqual(EMPTY_BAND_SECONDS, 3600)

    def test_an_empty_band_is_not_searched_again_inside_the_hour(self):
        clock, x = Clock(), CountingX([])
        radio = source(x, clock)
        self.assertEqual(radio.live("guitar"), [])
        clock.t += 55 * MINUTE
        self.assertEqual(radio.live("guitar"), [])
        self.assertEqual(len(x.urls), 1, "the second ask inside the hour made a paid X search")

    def test_an_empty_band_is_searched_again_after_the_hour(self):
        clock, x = Clock(), CountingX([])
        radio = source(x, clock)
        radio.live("guitar")
        clock.t += EMPTY_BAND_SECONDS + 1
        radio.live("guitar")
        self.assertEqual(len(x.urls), 2)

    def test_an_empty_band_stays_empty_on_a_second_instance_inside_the_hour(self):
        store, clock, x = MemoryStore(), Clock(), CountingX([])
        source(x, clock, store).live("guitar")
        clock.t += 30 * MINUTE
        self.assertEqual(source(x, clock, store).live("guitar"), [])
        self.assertEqual(len(x.urls), 1)

    def test_a_ticketed_only_answer_counts_as_empty_and_is_kept_the_hour_too(self):
        clock, x = Clock(), CountingX([x_item("1OwxWzqXyLbJQ", is_ticketed=True)])
        radio = source(x, clock)
        self.assertEqual(radio.live("guitar"), [])
        clock.t += 40 * MINUTE
        radio.live("guitar")
        self.assertEqual(len(x.urls), 1)

    def test_a_band_with_rooms_keeps_its_ten_minute_rule(self):
        clock, x = Clock(), CountingX([x_item("1OwxWzqXyLbJQ", "Guitar hang", 40)])
        radio = source(x, clock)
        self.assertEqual(len(radio.live("guitar")), 1)
        clock.t += 5 * MINUTE
        radio.live("guitar")
        self.assertEqual(len(x.urls), 1, "inside ten minutes the answer is still shared")
        clock.t += 6 * MINUTE   # 11 minutes in: the old rule asks X again
        radio.live("guitar")
        self.assertEqual(len(x.urls), 2)

    def test_an_empty_answer_does_not_hide_rooms_that_appear_after_the_hour(self):
        clock, x = Clock(), CountingX([])
        radio = source(x, clock)
        radio.live("guitar")
        x.items = [x_item("1OwxWzqXyLbJQ", "Guitar hang", 40)]
        clock.t += EMPTY_BAND_SECONDS + 1
        self.assertEqual([r.id for r in radio.live("guitar")], ["1OwxWzqXyLbJQ"])


class EmptyBandAnswerHeaderTests(unittest.TestCase):
    """What the CDN is told: an empty band is shared an hour, a band with rooms 30 minutes."""

    def reply(self, items, path="tune_raw", query="station=anything"):
        clock = Clock()
        radio = source(CountingX(items), clock)
        service = RadioService(radio, radio._budget)
        return getattr(service, path)(query)

    def test_an_empty_band_is_shared_for_the_hour(self):
        self.assertEqual(self.reply([]).cdn_seconds, EMPTY_BAND_SECONDS)

    def test_an_empty_search_of_your_own_band_is_shared_for_the_hour(self):
        self.assertEqual(self.reply([], "search_raw", "q=guitar").cdn_seconds, EMPTY_BAND_SECONDS)

    def test_a_band_with_rooms_keeps_its_thirty_minutes(self):
        rooms = [x_item("1OwxWzqXyLbJQ", "Guitar hang", 40)]
        self.assertEqual(self.reply(rooms).cdn_seconds, FRESH_SECONDS)
        self.assertEqual(self.reply(rooms, "search_raw", "q=guitar").cdn_seconds, FRESH_SECONDS)


if __name__ == "__main__":
    unittest.main()
