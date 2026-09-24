"""Docking: two radios, one tunnel. No network: the relay is an in-memory store with a fake clock."""
import json
import unittest

from spaces_radio.dock import CLAIM_SECONDS, IDLE_SECONDS, DockError, MemoryStore, beat, clean_state, parse_beat
from spaces_radio.service import dock_post

TOKEN = "ERID-42.3f9a0c1b2d4e"
SHIP_A, SHIP_B, SHIP_C = "a" * 16, "b" * 16, "c" * 16
ROOM = {"id": "1yJAPwQqZoNGb", "title": "Ball Talk", "listeners": 104}


class Clock:
    def __init__(self):
        self.t = 1_000_000.0

    def __call__(self):
        return self.t


def body(role, ship, state=None, token=TOKEN):
    return json.dumps({"token": token, "role": role, "ship": ship, "state": state or {}}).encode()


class ParseTests(unittest.TestCase):
    def test_good_beat(self):
        b = parse_beat(body("a", SHIP_A, {"room": ROOM, "air": True, "band": "sports"}))
        self.assertEqual((b.token, b.role, b.ship), (TOKEN, "a", SHIP_A))
        self.assertEqual(b.state["room"]["title"], "Ball Talk")
        self.assertTrue(b.state["air"])

    def test_bad_beats(self):
        for raw in (b"", b"[]", b"{", b"x" * 3000,
                    body("c", SHIP_A), body("a", "nothex"), body("a", SHIP_A, token="erid-42.3f9a"),
                    body("a", SHIP_A, token="ERID-42/../../x")):
            with self.assertRaises(DockError, msg=raw[:40]):
                parse_beat(raw)

    def test_state_is_cleaned(self):
        s = clean_state({"room": {"id": "../etc", "title": "x"}, "air": "yes", "left": 1,
                         "tone": {"kind": "shout", "seq": 1}, "band": "b" * 100})
        self.assertEqual((s["room"], s["air"], s["left"], s["tone"], len(s["band"])), (None, False, False, None, 24))
        t = clean_state({"tone": {"kind": "come", "seq": 3, "room": {**ROOM, "title": "Hi‮\u0007 there"}}})
        self.assertEqual(t["tone"]["kind"], "come")
        self.assertEqual(t["tone"]["room"]["title"], "Hi there")
        self.assertIsNone(clean_state({"tone": {"kind": "fist", "seq": -2}})["tone"])


class BeatTests(unittest.TestCase):
    def setUp(self):
        self.clock = Clock()
        self.store = MemoryStore(now=self.clock)

    def send(self, role, ship, state=None):
        return beat(self.store, parse_beat(body(role, ship, state)), self.clock())

    def test_two_ships_see_each_other(self):
        self.assertEqual(self.send("a", SHIP_A, {"room": ROOM}), {"role": "a", "peer": None})
        self.clock.t += 3
        seen = self.send("b", SHIP_B, {"tone": {"kind": "fist", "seq": 1}})
        self.assertEqual(seen["peer"]["state"]["room"]["id"], ROOM["id"])
        self.assertEqual(seen["peer"]["age"], 3.0)
        back = self.send("a", SHIP_A, {"room": ROOM})
        self.assertEqual(back["peer"]["state"]["tone"], {"kind": "fist", "seq": 1, "room": None})

    def test_a_third_ship_finds_the_dock_full_until_the_slot_goes_quiet(self):
        self.send("b", SHIP_B)
        with self.assertRaises(DockError) as full:
            self.send("b", SHIP_C)
        self.assertEqual(full.exception.status, 409)
        self.clock.t += CLAIM_SECONDS + 1
        self.assertEqual(self.send("b", SHIP_C)["role"], "b")

    def test_a_ship_that_left_frees_its_slot_at_once(self):
        self.send("b", SHIP_B, {"left": True})
        self.assertEqual(self.send("b", SHIP_C)["role"], "b")

    def test_the_same_ship_can_beat_again_and_slots_expire(self):
        self.send("a", SHIP_A)
        self.send("a", SHIP_A)
        self.send("b", SHIP_B)
        self.clock.t += IDLE_SECONDS + 1
        self.assertIsNone(self.send("a", SHIP_A)["peer"])


class ServiceTests(unittest.TestCase):
    def test_reply_shapes(self):
        store = MemoryStore()
        ok = dock_post(body("a", SHIP_A), store=store, now=5.0)
        self.assertEqual((ok.status, ok.cdn_seconds, ok.body["data"]["role"]), (200, 0, "a"))
        self.assertEqual(dock_post(b"nope", store=store).status, 400)
        dock_post(body("b", SHIP_B), store=store, now=5.0)
        self.assertEqual(dock_post(body("b", SHIP_C), store=store, now=6.0).status, 409)

    def test_relay_errors_become_503(self):
        class Broken:
            def get(self, key):
                raise RuntimeError("cache down")

            def set(self, key, value, options=None):
                raise RuntimeError("cache down")

        reply = dock_post(body("a", SHIP_A), store=Broken())
        self.assertEqual(reply.status, 503)
        self.assertFalse(reply.body["success"])


if __name__ == "__main__":
    unittest.main()
