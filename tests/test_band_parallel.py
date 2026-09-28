"""A band waits for its slower word, not for both words one after the other.
No network: the sources are fakes that answer from a word's table, slowly when asked."""
import threading
import time
import unittest

from spaces_radio.space import Space
from spaces_radio.sources import SourceError, StaleRooms, gather
from spaces_radio.stations import STATIONS, tune

ID_A, ID_B, ID_C = "1YqKDqWqdPLxV", "1OwxWzqXyLbJQ", "1gqxvQoBjBVJB"


def room(space_id, title="Room", listeners=10, topic=""):
    return Space(id=space_id, title=title, listeners=listeners, topic=topic)


class FakeSource:
    """Answers from `answers`, after `delay` seconds, and refuses the words in `errors`."""

    def __init__(self, answers=None, delay=0.0, errors=None, name="fake"):
        self.answers, self.delay, self.errors, self.words = dict(answers or {}), delay, dict(errors or {}), []
        self.name = name
        self._lock = threading.Lock()

    def live(self, topic):
        with self._lock:
            self.words.append(topic)
        if self.delay:
            time.sleep(self.delay)
        if topic in self.errors:
            raise self.errors[topic]
        return list(self.answers.get(topic, []))


def sequential_band(sources, station):
    """What tuning looked like one word at a time: the merge a listener already sees."""
    rooms, problems = {}, []
    for word in STATIONS[station]:
        found, errs = gather(sources, word)
        for space in found:
            rooms.setdefault(space.id, space.tagged(station))
        problems.extend(e for e in errs if e not in problems)
    return sorted(rooms.values(), key=lambda s: -s.listeners), problems


class BandParallelTests(unittest.TestCase):
    def test_two_words_are_searched_at_the_same_time(self):
        first, second = STATIONS["music"]
        source = FakeSource({first: [room(ID_A)], second: [room(ID_B)]}, delay=0.3)
        started = time.monotonic()
        tune("music", [source])
        self.assertLess(time.monotonic() - started, 0.5)  # 0.6 s if the words queue up

    def test_a_room_from_both_words_shows_once_with_the_first_words_room(self):
        first, second = STATIONS["music"]
        source = FakeSource({first: [room(ID_A, "Guitar hang", 40, topic=first)],
                             second: [room(ID_A, "Guitar hang, again", 4, topic=second),
                                      room(ID_B, "Open mic", 90, topic=second)]})
        rooms, _ = tune("music", [source])
        self.assertEqual([(r.id, r.title, r.topic) for r in rooms],
                         [(ID_B, "Open mic", "music"), (ID_A, "Guitar hang", "music")])

    def test_the_same_problem_from_both_words_is_heard_once(self):
        first, second = STATIONS["music"]
        rooms_source = FakeSource({first: [room(ID_A, "One", 5), room(ID_C, "Three", 60)],
                                   second: [room(ID_B, "Two", 90), room(ID_A, "One again", 99)]})
        quiet = FakeSource(name="quiet", errors={first: SourceError("X said no."),
                                                 second: SourceError("X said no.")})
        rooms, problems = tune("music", [rooms_source, quiet])
        self.assertEqual(([(r.id, r.title) for r in rooms], problems),
                         ([(ID_B, "Two"), (ID_C, "Three"), (ID_A, "One")], ["quiet: X said no."]))

    def test_one_word_failing_still_fills_the_band(self):
        first, second = STATIONS["music"]
        source = FakeSource({first: [room(ID_A, 40)], second: [room(ID_B, 90)]},
                            errors={second: SourceError("Today's X fuel is used up.")})
        rooms, problems = tune("music", [source])
        self.assertEqual(([r.id for r in rooms], problems),
                         ([ID_A], ["fake: Today's X fuel is used up."]))

    def test_stale_rooms_from_one_word_still_fill_the_band(self):
        first, second = STATIONS["music"]
        shelf = StaleRooms("Today's X fuel is used up: showing rooms from 5 min ago.",
                           [room(ID_C, "Older room", 3)], 300.0)
        source = FakeSource({first: [room(ID_B, "Fresh room", 90)]}, errors={second: shelf})
        rooms, problems = tune("music", [source])
        self.assertEqual(([r.id for r in rooms], problems), ([ID_B, ID_C], [str(shelf)]))

    def test_a_sequential_run_says_the_same_thing(self):
        source = FakeSource({STATIONS["sports"][0]: [room(ID_A, "Stadium", 12)],
                             STATIONS["sports"][1]: [room(ID_B, "Talk", 44)]})
        self.assertEqual(tune("sports", [source]), sequential_band([source], "sports"))


if __name__ == "__main__":
    unittest.main()
