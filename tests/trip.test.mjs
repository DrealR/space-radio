// node --test tests/*.mjs — the phone's trip to X and back.
import test from "node:test";
import assert from "node:assert/strict";
import { TRIP_MAX_MS, readTrip, returnPlan } from "../public/js/trip.js";
import { LEARNED_NONE, readLearned } from "../public/js/learned.js";

const NOW = 1_700_000_000_000;
const good = { roomId: "1YqKDqWqdPLxV", band: "music", title: "Night owls", at: NOW - 60000 };

test("a fresh trip comes back intact and frozen", () => {
  const trip = readTrip(JSON.stringify(good), NOW);
  assert.deepEqual(trip, good);
  assert.ok(Object.isFrozen(trip));
});

test("junk JSON, wrong shapes and bad ids are refused", () => {
  for (const raw of [null, "", "{", "[]", "42", "\"x\"", JSON.stringify({ ...good, roomId: "x.com/i/spaces/1YqKDqWqdPLxV" }),
    JSON.stringify({ ...good, roomId: "<img src=x>" }), JSON.stringify({ ...good, roomId: 12345678 }),
    JSON.stringify({ ...good, at: "yesterday" })]) {
    assert.equal(readTrip(raw, NOW), null, String(raw));
  }
});

test("trips older than 30 minutes, or from the future, are forgotten", () => {
  assert.equal(readTrip(JSON.stringify({ ...good, at: NOW - TRIP_MAX_MS }), NOW), null);
  assert.equal(readTrip(JSON.stringify({ ...good, at: NOW + 5000 }), NOW), null);
  assert.ok(readTrip(JSON.stringify({ ...good, at: NOW - TRIP_MAX_MS + 1 }), NOW));
});

test("odd titles and bands are trimmed, not trusted", () => {
  const trip = readTrip(JSON.stringify({ ...good, title: "t".repeat(500), band: 7 }), NOW);
  assert.equal(trip.title.length, 200);
  assert.equal(trip.band, "");
});

test("learned flags validate, and fall back to showing the tips", () => {
  assert.equal(readLearned(null), LEARNED_NONE);
  assert.equal(readLearned("{nope"), LEARNED_NONE);
  assert.deepEqual(readLearned(JSON.stringify({ push: true, confirms: 3, preflight: "yes", crew: true })),
    { push: true, confirms: 3, preflight: false, crew: true });
  assert.equal(readLearned(JSON.stringify({ confirms: -4 })).confirms, 0);
  assert.equal(readLearned(JSON.stringify({ confirms: 2.5 })).confirms, 0);
});

test("coming back: memory wins; storage only speaks after a cold reload", () => {
  const trip = readTrip(JSON.stringify(good), NOW);
  const expired = readTrip(JSON.stringify({ ...good, at: NOW - TRIP_MAX_MS }), NOW);
  assert.equal(returnPlan({ phase: "away" }, null), "back");
  assert.equal(returnPlan({ phase: "away" }, expired), "back");
  assert.equal(returnPlan({ phase: "idle" }, trip), "restore");
  assert.equal(returnPlan({ phase: "idle" }, null), null);
  for (const phase of ["onair", "airlock", "back", "lost", "blocked"]) {
    assert.equal(returnPlan({ phase, inTab: false }, trip), null, phase);
  }
  // pageshow after visibilitychange: now we know X played in this tab.
  assert.equal(returnPlan({ phase: "back", inTab: false }, null, true), "back");
  assert.equal(returnPlan({ phase: "back", inTab: true }, null, true), null);
});
