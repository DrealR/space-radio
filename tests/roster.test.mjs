// node --test tests/*.mjs — what a crew scan teaches the dial, validated and never mutated.
import test from "node:test";
import assert from "node:assert/strict";
import { ROSTER_TTL_MS, addRoster, freshRoster, rosterFrom, withRoster } from "../public/js/roster.js";

const NOW = 1_700_000_000_000;
const data = { counts: { hosts: 3, speakers: 6 }, listeners: 214, host: { username: "sr26_captain" }, at: NOW };
const room = Object.freeze({ id: "1YqKDqWqdPLxV", title: "t", listeners: 40, hosts: 1, speakers: 2 });

test("keeps only validated counts and a real handle", () => {
  assert.deepEqual(rosterFrom(data, NOW), { hosts: 3, speakers: 6, listeners: 214, host: "sr26_captain", at: NOW });
  const junk = rosterFrom({ counts: { hosts: -1, speakers: "8" }, listeners: 1.5, host: { username: "<b>evil</b>" } }, NOW);
  assert.deepEqual(junk, { hosts: 0, speakers: 0, listeners: 0, host: "", at: NOW });
  assert.deepEqual(rosterFrom(null, NOW), { hosts: 0, speakers: 0, listeners: 0, host: "", at: NOW });
});

test("lays the scan over the room while fresh, never editing either", () => {
  const rosters = Object.freeze(addRoster({}, room.id, data, NOW));
  const shown = withRoster(room, rosters, NOW + 1000);
  assert.deepEqual([shown.hosts, shown.speakers, shown.listeners], [3, 6, 214]);
  assert.equal(room.listeners, 40);
  assert.equal(withRoster(room, rosters, NOW + ROSTER_TTL_MS), room);
  assert.equal(freshRoster(rosters, "other", NOW), null);
  assert.equal(withRoster(null, rosters, NOW), null);
});

test("adding a roster returns a new map", () => {
  const before = Object.freeze({});
  const after = addRoster(before, room.id, data, NOW);
  assert.notEqual(after, before);
  assert.deepEqual(Object.keys(before), []);
});
