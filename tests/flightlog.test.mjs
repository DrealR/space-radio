// node --test tests/*.mjs — the flight log: ships you boarded, kept in this browser only.
import test from "node:test";
import assert from "node:assert/strict";
import {
  CONTINUE_MS, MAX_FLIGHTS, MAX_FLIGHT_MS, duration, flightKey, flightTime, logFlight, readLog, removeFlight,
  stamp, totalAboard,
} from "../public/js/flightlog.js";
import { AIR_IDLE } from "../public/js/airlock.js";

const T0 = 1_790_000_000_000;
const MIN = 60000;
const ID_A = "1YqKDqWqdPLxV";
const ID_B = "1OwxWzqXyLbJQ";
const roomA = Object.freeze({ id: ID_A, title: "Late night lo-fi", listeners: 40, host_ids: ["11", "22"] });
const roomB = Object.freeze({ id: ID_B, title: "Open mic", listeners: 9, host_ids: [] });
const air = (phase, roomId = ID_A, since = T0) => Object.freeze({ ...AIR_IDLE, phase, roomId, since });
const obs = (extra) => ({ air: air("airlock"), room: roomA, band: "music", host: "", hostId: "", wasAboard: false, now: T0, ...extra });

test("boarding a ship starts a flight; idle and blocked log nothing", () => {
  const empty = Object.freeze([]);
  assert.equal(logFlight(empty, obs({ air: AIR_IDLE })), empty);
  assert.equal(logFlight(empty, obs({ air: air("blocked") })), empty);
  const log = logFlight(empty, obs());
  assert.equal(empty.length, 0, "never edits the log it was given");
  assert.equal(log.length, 1);
  assert.deepEqual({ ...log[0] }, {
    id: ID_A, title: "Late night lo-fi", band: "music", host: "", hostId: "", hostIds: ["11", "22"],
    start: T0, last: T0, heard: false, people: 40,
  });
  assert.ok(Object.isFrozen(log) && Object.isFrozen(log[0]));
});

test("the same flight runs on: heard, time aboard, the host once the crew is named", () => {
  let log = logFlight([], obs());
  log = logFlight(log, obs({ air: air("onair"), wasAboard: true, now: T0 + 5 * MIN }));
  log = logFlight(log, obs({ air: air("onair"), wasAboard: true, now: T0 + 30 * MIN, host: "sr26_captain", hostId: "11",
                             room: { ...roomA, listeners: 80 } }));
  assert.equal(log.length, 1);
  assert.equal(log[0].heard, true);
  assert.equal(flightTime(log[0]), 30 * MIN);
  assert.equal(log[0].host, "sr26_captain");
  assert.equal(log[0].hostId, "11");
  assert.equal(log[0].people, 80, "the biggest crowd seen");
});

test("unchanged observations return the very same log (no needless saves)", () => {
  const log = logFlight([], obs());
  assert.equal(logFlight(log, obs({ air: air("lost"), wasAboard: true, now: T0 + 9 * MIN })), log,
    "lost track: the radio can't tell, so the clock doesn't run");
});

test("a phone trip counts from leaving to coming back, however long", () => {
  let log = logFlight([], obs({ air: air("away", ID_A, T0), now: T0 }));
  // The page slept while X played; on return the airlock's `since` is the moment we came back.
  log = logFlight(log, obs({ air: air("back", ID_A, T0 + 95 * MIN), wasAboard: true, now: T0 + 95 * MIN }));
  assert.equal(log.length, 1);
  assert.equal(flightTime(log[0]), 95 * MIN);
});

test("a reload mid-trip continues the flight it left, by the trip's own time", () => {
  let log = logFlight([], obs({ air: air("away", ID_A, T0), now: T0 }));
  log = logFlight(log, obs({ air: air("away", ID_A, T0), wasAboard: false, now: T0 + 25 * MIN }));
  assert.equal(log.length, 1);
});

test("a new room, or the same room much later, is a new flight, newest first", () => {
  let log = logFlight([], obs());
  log = logFlight(log, obs({ air: air("airlock", ID_B), room: roomB, now: T0 + MIN }));
  assert.deepEqual(log.map((f) => f.id), [ID_B, ID_A]);
  log = logFlight(log, obs({ air: air("airlock", ID_B), room: roomB, now: T0 + MIN + CONTINUE_MS + 1 }));
  assert.equal(log.length, 3);
  const again = logFlight(log, obs({ air: air("airlock", ID_B), room: roomB, now: T0 + MIN + CONTINUE_MS + 2 }));
  assert.equal(again.length, 3, "back within ten minutes: the same flight");
});

test("bounded: at most MAX_FLIGHTS, and no flight runs past twelve hours", () => {
  let log = [];
  for (let k = 0; k < MAX_FLIGHTS + 5; k++) {
    log = logFlight(log, obs({ air: air("airlock", k % 2 ? ID_A : ID_B), now: T0 + k * (CONTINUE_MS + 1) }));
  }
  assert.equal(log.length, MAX_FLIGHTS);
  const long = logFlight(logFlight([], obs()), obs({ air: air("onair"), wasAboard: true, now: T0 + 3 * MAX_FLIGHT_MS }));
  assert.equal(flightTime(long[0]), MAX_FLIGHT_MS);
});

test("stored flights are rebuilt, never trusted", () => {
  const good = { id: ID_A, title: "Fine‮ room", band: "my:GTR", host: "sr26_captain", hostId: "11",
                 hostIds: ["11", "x", 5], start: T0, last: T0 + MIN, heard: true, people: 3 };
  const raw = [good, { ...good, id: "no" }, null, "junk", { ...good, start: "yesterday" },
               { ...good, last: T0 - 1 }, { ...good, host: "<b>", hostId: "11", start: T0 + 5, last: T0 + 6 }, good];
  const log = readLog(raw);
  assert.equal(log.length, 2, "bad ids, bad times and the exact duplicate are dropped");
  assert.equal(log[0].title, "Fine room");
  assert.deepEqual(log[0].hostIds, ["11"]);
  assert.equal(log[1].host, "");
  assert.equal(log[1].hostId, "", "an id is kept only beside a real handle");
  assert.deepEqual(readLog("nope"), []);
  assert.deepEqual(readLog(null), []);
  assert.equal(readLog(Array(MAX_FLIGHTS + 9).fill(0).map((_, k) => ({ ...good, start: T0 + k, last: T0 + k }))).length, MAX_FLIGHTS);
});

test("delete one, keys, totals and the words the log shows", () => {
  let log = logFlight([], obs());
  log = logFlight(log, obs({ air: air("onair", ID_B), room: roomB, now: T0 + MIN }));
  log = logFlight(log, obs({ air: air("onair", ID_B), room: roomB, wasAboard: true, now: T0 + 43 * MIN }));
  assert.equal(totalAboard(log), 42 * MIN);
  const key = flightKey(log[1]);
  assert.equal(key, `${ID_A}@${T0}`);
  const fewer = removeFlight(log, key);
  assert.deepEqual(fewer.map((f) => f.id), [ID_B]);
  assert.equal(log.length, 2);
  assert.equal(duration(20 * 1000), "<1M");
  assert.equal(duration(42 * MIN), "42M");
  assert.equal(duration(125 * MIN), "2H05");
  const at = new Date(2026, 8, 25, 21, 4);
  assert.equal(stamp(at.getTime()), "SEP 25 · 21:04");
});
