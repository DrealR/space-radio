// node --test tests/*.mjs — one press, one plan; the dial never touches X.
import test from "node:test";
import assert from "node:assert/strict";
import { ISOLATION_MS, planPush, readWindow } from "../public/js/listener.js";

const desk = (patch) => planPush({ kind: "desktop", phase: "idle", sameRoom: false, alive: false, blocked: false, ...patch });

test("phone: the button is always its own same-tab link", () => {
  for (const phase of ["idle", "away", "back", "onair"]) {
    assert.equal(planPush({ kind: "phone", phase, sameRoom: true, alive: false, blocked: false }), "link");
  }
});

test("blocked pop-ups turn the button into a plain new-tab link", () => {
  assert.equal(desk({ blocked: true }), "newtab");
  assert.equal(desk({ blocked: true, phase: "onair", sameRoom: true, alive: true }), "newtab");
});

test("same room: bring our X window forward, never reload or open a second", () => {
  for (const phase of ["airlock", "onair"]) {
    assert.equal(desk({ phase, sameRoom: true, alive: true }), "focus");
    assert.equal(desk({ phase, sameRoom: true, alive: false }), "remind");
  }
});

test("another room: steer the X window we hold, else open a fresh one", () => {
  for (const phase of ["airlock", "onair", "lost"]) {
    assert.equal(desk({ phase, alive: true }), "steer");
    assert.equal(desk({ phase, alive: false }), "open");
  }
  assert.equal(desk({ phase: "idle", alive: true }), "open");
  assert.equal(desk({ phase: "lost", sameRoom: true, alive: false }), "open");
});

test("a window that vanishes at once was cut off by X, not closed by you", () => {
  const t = 10_000;
  assert.equal(readWindow({ handle: "unknown", openedAt: t, now: t + 500, alive: false }), "cut");
  assert.equal(readWindow({ handle: "unknown", openedAt: t, now: t + 500, alive: true }), null);
});

test("still reachable after the grace period means kept; gone later means closed", () => {
  const t = 10_000;
  const later = t + ISOLATION_MS;
  assert.equal(readWindow({ handle: "unknown", openedAt: t, now: later, alive: true }), "kept");
  assert.equal(readWindow({ handle: "kept", openedAt: t, now: later + 60_000, alive: true }), null);
  assert.equal(readWindow({ handle: "kept", openedAt: t, now: later + 60_000, alive: false }), "closed");
  assert.equal(readWindow({ handle: "unknown", openedAt: t, now: later, alive: false }), "cut");
  assert.equal(readWindow({ handle: "cut", openedAt: t, now: later, alive: false }), null);
  assert.equal(readWindow({ handle: "none", openedAt: t, now: later, alive: false }), null);
});

test("a slow X page is never mistaken for a kept window, or its loss for a closed one", () => {
  const t = 10_000;
  const later = t + ISOLATION_MS + 5000;
  // Still on the blank page every pop-up starts with: not ours to keep yet.
  assert.equal(readWindow({ handle: "unknown", openedAt: t, now: later, alive: true, committed: false }), null);
  assert.equal(readWindow({ handle: "unknown", openedAt: t, now: later, alive: true, committed: true }), "kept");
  // Gone before we ever kept it: X cut us off as its page arrived, whatever the age.
  assert.equal(readWindow({ handle: "unknown", openedAt: t, now: later, alive: false, committed: false }), "cut");
});
