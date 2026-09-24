// node --test tests/*.mjs — reaching the X window without ever playing two rooms at once.
import test from "node:test";
import assert from "node:assert/strict";
import { ISOLATION_MS, planJoin, readWindow } from "../public/js/listener.js";
import { joinCopy } from "../public/js/handoff.js";

test("phone: the link opens the app on a push; flipping alone waits", () => {
  assert.equal(planJoin({ phone: true, steer: "unknown", windowAlive: false, gesture: true }), "open-link");
  assert.equal(planJoin({ phone: true, steer: "unknown", windowAlive: false, gesture: false }), "pending");
});

test("computer: steer when X lets us, otherwise only a push opens a window", () => {
  assert.equal(planJoin({ phone: false, steer: "yes", windowAlive: true, gesture: false }), "steer");
  assert.equal(planJoin({ phone: false, steer: "no", windowAlive: false, gesture: false }), "pending");
  assert.equal(planJoin({ phone: false, steer: "no", windowAlive: false, gesture: true }), "open");
  assert.equal(planJoin({ phone: false, steer: "unknown", windowAlive: true, gesture: false }), "pending");
  assert.equal(planJoin({ phone: false, steer: "yes", windowAlive: false, gesture: true }), "open");
});

test("a window that vanishes at once means X cut us off, not that you left", () => {
  const t = 10_000;
  assert.deepEqual(readWindow({ steer: "unknown", openedAt: t, now: t + 500, alive: false }),
                   { steer: "no", userClosed: false });
});

test("a window still reachable after the grace period can be steered; closing it later ends listening", () => {
  const t = 10_000;
  assert.deepEqual(readWindow({ steer: "unknown", openedAt: t, now: t + 500, alive: true }),
                   { steer: "unknown", userClosed: false });
  assert.deepEqual(readWindow({ steer: "unknown", openedAt: t, now: t + ISOLATION_MS + 1, alive: true }),
                   { steer: "yes", userClosed: false });
  assert.deepEqual(readWindow({ steer: "yes", openedAt: t, now: t + 60_000, alive: false }),
                   { steer: "yes", userClosed: true });
});

test("button words follow what's on air", () => {
  assert.equal(joinCopy({ phone: false, listening: true, here: false }).text, "PUSH TO SWITCH");
  assert.match(joinCopy({ phone: false, listening: true, here: false }).sub, /close the old one/);
  assert.match(joinCopy({ phone: false, listening: true, here: true, steer: "yes" }).sub, /follows the dial/);
  assert.match(joinCopy({ phone: false, listening: true, here: true, steer: "no" }).sub, /your X tab/);
  assert.equal(joinCopy({ phone: true, listening: true, here: false }).text, "PUSH TO SWITCH");
});
