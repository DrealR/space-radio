// node --test tests/*.mjs — SCAN lines up the next ship; it never moves the needle under an open manifest.
import test from "node:test";
import assert from "node:assert/strict";
import { nextScanAt, scanDue, scanning } from "../public/js/scan.js";

const due = (patch) => scanDue({ scan: true, phase: "onair", scanAt: 1000, now: 1000, crewOpen: false, ...patch });

test("a hop is due once its time comes, while X has a room", () => {
  assert.equal(due({}), true);
  assert.equal(due({ phase: "airlock" }), true);
  assert.equal(due({ now: 999 }), false);
  assert.equal(due({ scan: false }), false);
  assert.equal(due({ scanAt: 0 }), false);
  for (const phase of ["idle", "lost", "blocked", "away", "back"]) assert.equal(due({ phase }), false, phase);
});

test("never while the crew manifest is open: its buttons name one room", () => {
  assert.equal(due({ crewOpen: true }), false);
  assert.equal(due({ crewOpen: false, now: 50_000 }), true); // it hops once the manifest closes
});

test("the next hop is set only when SCAN is on and X has a room", () => {
  assert.equal(nextScanAt({ scan: true, phase: "onair", now: 1000, minutes: 5 }), 301_000);
  assert.equal(nextScanAt({ scan: false, phase: "onair", now: 1000, minutes: 5 }), 0);
  assert.equal(nextScanAt({ scan: true, phase: "idle", now: 1000, minutes: 5 }), 0);
  assert.deepEqual(["airlock", "onair", "idle"].map(scanning), [true, true, false]);
});
