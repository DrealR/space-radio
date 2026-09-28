// node --test tests/*.mjs — the Sky Survey's findings for the radio page.
// Every test here is written as a user would notice it. They came in `todo: true` and stayed
// that way while the order only found and proved; the fixes have landed and each one runs.
// Pure modules are imported; app.js is loaded the way tests/tune-race.test.mjs does it, by
// slicing the function out of the source and running it against a fake page.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { crewOptions } from "../public/js/aboard.js";
import { wireKnob } from "../public/js/knob.js";
import { wireKeys } from "../public/js/keys.js";

// ---- one fake page for the modules that reach for the document ------------------------------
let keydown = null;
const node = (id) => ({
  id, dataset: {}, open: false, focused: 0, textContent: "", value: "",
  classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
  addEventListener() {}, removeAttribute() {}, setAttribute() {}, focus() { this.focused += 1; },
  showModal() { this.open = true; }, close() { this.open = false; },
  getBoundingClientRect: () => ({ left: 0, right: 0, top: 0, width: 0 }),
});
const nodes = new Map();
globalThis.document = {
  getElementById: (id) => nodes.get(id) || nodes.set(id, node(id)).get(id),
  addEventListener: (type, fn) => { if (type === "keydown") keydown = fn; },
};

// ---- 1. the slow start (app.js) -------------------------------------------------------------
const appSource = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const tuneInStart = appSource.indexOf("async function tuneIn(");
const tuneInEnd = appSource.indexOf("\nstart();", tuneInStart);
assert.ok(tuneInStart >= 0 && tuneInEnd > tuneInStart, "tuneIn() is present in app.js");
const tuneInSource = appSource.slice(tuneInStart, tuneInEnd);

/** The radio's start-up: ask the tower for its bands, then tune one. The clock is ours. */
function makeRadio({ hidden, answer }) {
  const timers = [];
  const spends = [];
  let state = { band: "anything", myBands: [], liveSearch: true };
  const set = (patch) => { state = { ...state, ...patch }; };
  const env = {
    api: (path) => answer(path),
    tuneBand: async (band) => { spends.push(band); },
    findBand: (bands, key) => bands.find((b) => `my:${b.name}` === key) || null,
    readBeam: () => null,
    readDock: () => null,
    tunnel: { join() {}, restore() {} },
    preloadCrew: () => {},
    location: { search: "", pathname: "/" },
    history: { replaceState() {} },
    document: { hidden },
    RETRY_STATUS_MS: 60000,
    REFRESH_MS: 1800000,
  };
  const names = Object.keys(env);
  // The radio keeps its own state, so set() here moves the band the listener pressed: a fake that
  // kept a second copy would hide the very race this page is about.
  const radio = new Function("initial", "setTimeout", "setInterval", ...names, `
    let state = initial;
    const set = (patch) => { state = { ...state, ...patch }; };
    ${tuneInSource}
    return { tuneIn, set, get state() { return state; } };
  `)(state, (fn) => { timers.push(fn); return timers.length; }, () => 0, ...names.map((k) => env[k]));
  return { tuneIn: radio.tuneIn, set: radio.set, timers, spends, get state() { return radio.state; } };
}

const okStatus = { data: { stations: ["anything", "music", "late night"], live_search: true }, meta: {} };

test("starting up late never re-tunes the band the listener moved to, and never spends a search in a hidden tab",
  async () => {
    // The tower is slow. While it thinks, the listener presses a band key of their own.
    let reply = null;
    const slow = makeRadio({ hidden: false, answer: () => new Promise((done) => { reply = () => done(okStatus); }) });
    const starting = slow.tuneIn({ band: "late night" });
    slow.set({ band: "music" }); // the listener's own choice, already paid for
    reply();
    await starting;
    assert.deepEqual(slow.spends, [], "the start must not buy a band search the listener already bought");
    assert.equal(slow.state.band, "music", "the band the listener chose stays chosen");

    // The tower said no, so the radio lined up a retry. It fires a minute later, in a tab
    // nobody is looking at, and buys a band search anyway.
    const hidden = makeRadio({ hidden: true, answer: (path) => (path === "/api/status"
      ? { error: "The radio can't reach its tower right now." } : okStatus) });
    await hidden.tuneIn({ band: "music" });
    assert.equal(hidden.timers.length, 1, "a failed start asks again in a minute");
    await hidden.timers[0]();
    assert.deepEqual(hidden.spends, [], "a hidden tab spends nothing");
  });

// ---- 2. the crew manifest's PUSH (aboard.js) ------------------------------------------------
test("PUSH in the crew manifest never boards a room the manifest does not name", () => {
  const A = { id: "1YqKDqWqdPLxV", title: "Night owls" };
  const B = { id: "1OwxWzXyLbJQ", title: "Morning show" };
  let state = { air: { phase: "idle", roomId: null }, currentId: A.id, rosters: {}, ended: [], learned: { crew: true } };
  let calls = [];
  const note = (name) => (...args) => { calls = [...calls, [name, ...args]]; };
  let deck = [A, B];
  const app = {
    get state() { return state; },
    device: { kind: "desktop" },
    current: () => deck.find((r) => r.id === state.currentId),
    deck: () => deck,
    select: (id) => { state = { ...state, currentId: id }; calls = [...calls, ["select", id]]; },
    copy: () => ({ ptt: { text: "PUSH TO LISTEN", sub: "", mode: "intercept" }, here: false, linedUp: false }),
    channelLabel: () => "CH 01 · 88.1 FM", set: note("set"), step: note("step"), render: note("render"), sfxOk: () => false,
  };
  const launch = { push: note("push"), leaveForX: note("leaveForX") };

  // The manifest is open on A. A refresh drops A off the band and the needle lands on B.
  const opts = crewOptions(app, launch, A);
  state = { ...state, currentId: B.id };
  deck = [B];
  const click = { preventDefault() {} };
  opts.listen.onClick(click);

  // PUSH still gets the click itself: the crew's PUSH is a link, and launch.push needs the event
  // to stop it following and to read the modifier keys.
  assert.deepEqual(calls, [["select", A.id], ["push", click]],
    "the needle goes back to the room the manifest names");
});

// ---- 3. the TUNE knob (knob.js) -------------------------------------------------------------
test("ctrl+scroll over the TUNE knob zooms the page instead of tuning a room", () => {
  const handlers = {};
  const knob = {
    addEventListener: (type, fn) => { handlers[type] = fn; },
    setPointerCapture() {},
  };
  let steps = 0;
  wireKnob(knob, () => { steps += 1; }, () => {});
  // A real WheelEvent arrives with defaultPrevented false; only a call to preventDefault sets it.
  const zoom = { deltaY: 120, ctrlKey: true, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
  handlers.wheel(zoom);
  assert.equal(zoom.defaultPrevented, false, "the browser keeps its zoom gesture");
  assert.equal(steps, 0, "a zoom gesture never tunes a room");
});

// ---- 4. the ORDER keys (keys.js + index.html) -----------------------------------------------
test("the arrow keys move the ORDER choice instead of tuning the radio", () => {
  const calls = [];
  wireKeys({
    blocked: () => false,
    tune: (delta) => calls.push(["tune", delta]), push: () => calls.push(["push"]),
    heard: () => {}, crew: () => {}, radar: () => {}, openX: () => {}, manual: () => {}, escape: () => {},
  });
  assert.equal(typeof keydown, "function", "the page wires one keydown listener");
  // A <button> in the ORDER radiogroup: not a text field, but not the radio either.
  const order = { closest: () => null };
  keydown({ key: "ArrowRight", target: order, defaultPrevented: false, metaKey: false, ctrlKey: false, altKey: false, preventDefault() {} });
  assert.deepEqual(calls, [], "the ORDER control owns its arrow keys");
});
