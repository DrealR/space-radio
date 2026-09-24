// node --test tests/*.mjs — the TUNE knob: every way of pressing it tunes exactly once.
import test from "node:test";
import assert from "node:assert/strict";
import { wireKnob } from "../public/js/knob.js";

function fakeKnob() {
  let handlers = {};
  return {
    addEventListener: (type, fn) => { handlers = { ...handlers, [type]: fn }; },
    setPointerCapture: () => {},
    fire: (type, e = {}) => handlers[type]?.({ preventDefault() {}, pointerId: 1, clientX: 0, clientY: 0, ...e }),
  };
}

function wired() {
  const knob = fakeKnob();
  let steps = [];
  wireKnob(knob, (d) => { steps = [...steps, d]; }, () => {});
  return { knob, get steps() { return steps; } };
}

test("Enter or Space (a click with detail 0) tunes to the next room", () => {
  const w = wired();
  w.knob.fire("click", { detail: 0 });
  assert.deepEqual(w.steps, [1]);
});

test("a mouse or finger tap tunes once, not twice", () => {
  const w = wired();
  w.knob.fire("pointerdown");
  w.knob.fire("pointerup");
  w.knob.fire("click", { detail: 1 });
  assert.deepEqual(w.steps, [1]);
});

test("a drag tunes as it turns, and its click doesn't add a step", () => {
  const w = wired();
  w.knob.fire("pointerdown", { clientX: 0 });
  w.knob.fire("pointermove", { clientX: 70 });
  w.knob.fire("pointerup");
  w.knob.fire("click", { detail: 1 });
  assert.deepEqual(w.steps, [2]);
  w.knob.fire("click", { detail: 0 }); // a later key press still tunes
  assert.deepEqual(w.steps, [2, 1]);
});
