// node --test tests/*.mjs — the second Sky Survey of the radio page, and its three fixes.
// Written as a user would notice them: a tab nobody is looking at, a button that took focus,
// and a room that has already left the dial. app.js is loaded the way tests/tune-race.test.mjs
// and tests/survey-findings.test.mjs load it: by slicing the function out of the source and
// running it against a fake page, so the real code is what gets measured.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { crewOptions } from "../public/js/aboard.js";
import { wireKeys } from "../public/js/keys.js";

// ---- 1. a start that waits hidden (app.js) --------------------------------------------------
const appSource = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const tuneInStart = appSource.indexOf("async function tuneIn(");
const tuneInEnd = appSource.indexOf("\nstart();", tuneInStart);
assert.ok(tuneInStart >= 0 && tuneInEnd > tuneInStart, "tuneIn() is present in app.js");
const tuneInSource = appSource.slice(tuneInStart, tuneInEnd);

const okStatus = { data: { stations: ["anything", "music", "late night"], live_search: true }, meta: {} };

/** The radio's start-up against a fake tab. Its clock, its page and its bands are ours. */
function makeRadio({ hidden = true } = {}) {
  const timers = [];
  const intervals = [];
  const spends = [];
  const eyes = new Set();
  const document = {
    hidden,
    addEventListener: (type, fn) => { if (type === "visibilitychange") eyes.add(fn); },
    removeEventListener: (type, fn) => { if (type === "visibilitychange") eyes.delete(fn); },
  };
  const env = {
    api: (path) => (path === "/api/status" ? okStatus : { error: "not a band" }),
    tuneBand: async (band) => { spends.push(band); },
    findBand: (bands, key) => bands.find((b) => `my:${b.name}` === key) || null,
    readBeam: () => null,
    readDock: () => null,
    tunnel: { join() {}, restore() {} },
    preloadCrew: () => {},
    location: { search: "", pathname: "/" },
    history: { replaceState() {} },
    document,
    RETRY_STATUS_MS: 60000,
    REFRESH_MS: 1800000,
    landBeam: () => {},
    app: {},
  };
  const names = Object.keys(env);
  const radio = new Function("initial", "setTimeout", "setInterval", ...names, `
    let state = initial;
    const set = (patch) => { state = { ...state, ...patch }; };
    ${tuneInSource}
    return { tuneIn, set, get state() { return state; } };
  `)({ band: "anything", myBands: [], liveSearch: true },
    (fn) => { timers.push(fn); return timers.length; },
    (fn) => { intervals.push(fn); return intervals.length; },
    ...names.map((k) => env[k]));
  const settle = () => new Promise((done) => setImmediate(done));
  return {
    tuneIn: radio.tuneIn, set: radio.set, timers, intervals, spends, document, settle,
    // The tab comes forward: every visibilitychange listener hears it.
    lookedAt: async () => { document.hidden = false; [...eyes].forEach((fn) => fn()); await settle(); },
    waiting: () => eyes.size,
    get state() { return radio.state; },
  };
}

test("a tab left hidden buys one band, not one per start, and tunes the moment it is looked at", async () => {
  const radio = makeRadio({ hidden: true });
  // The tower answers, but nobody is here: the start waits, and waits again, and again.
  await radio.tuneIn({ band: "late night" });
  await radio.tuneIn({ band: "late night" });
  await radio.tuneIn({ band: "late night" });

  assert.deepEqual(radio.spends, [], "a hidden tab spends nothing at all");
  assert.equal(radio.intervals.length, 1, "the refresh timer is set up once, not once per start");
  assert.equal(radio.waiting(), 1, "one listener waits for the tab to be looked at");
  radio.intervals[0]();
  assert.deepEqual(radio.spends, [], "the refresh timer never buys a search in a hidden tab");

  radio.lookedAt();
  assert.deepEqual(radio.spends, ["late night"], "the radio tunes as soon as the tab is looked at");
  assert.equal(radio.waiting(), 0, "the wait is over once the tab has been looked at");
  assert.equal(radio.intervals.length, 1, "still one refresh timer");

  radio.lookedAt();
  await radio.settle();
  assert.deepEqual(radio.spends, ["late night"], "coming back to the tab buys nothing more");
});

test("a band the listener chose while the tab was hidden is never bought a second time", async () => {
  const radio = makeRadio({ hidden: true });
  await radio.tuneIn({ band: "late night" });
  radio.set({ band: "music" }); // their own choice, already paid for
  radio.lookedAt();
  assert.deepEqual(radio.spends, [], "their band stays bought; the waiting start stands down");
  assert.equal(radio.state.band, "music", "the band the listener chose stays chosen");
});

// ---- 2. the arrow keys (keys.js) -------------------------------------------------------------
let keydown = null;
globalThis.document = {
  getElementById: (id) => ({ id, focus() {} }),
  addEventListener: (type, fn) => { if (type === "keydown") keydown = fn; },
};

function wireRadio() {
  const calls = [];
  wireKeys({
    blocked: () => false, tune: (delta) => calls.push(["tune", delta]), push: () => calls.push(["push"]),
    heard: () => {}, crew: () => {}, radar: () => {}, openX: () => {}, manual: () => {}, escape: () => {},
  });
  return calls;
}

// An element that is inside the given group, and outside anything else.
const inGroup = (role) => ({ closest: (sel) => (sel.includes(role) ? { id: `group:${role}` } : null) });
const press = (target) => keydown({
  key: "ArrowRight", target, defaultPrevented: false,
  metaKey: false, ctrlKey: false, altKey: false, repeat: false, preventDefault() {},
});

test("a plain button that took focus leaves the arrow keys to the radio", () => {
  const calls = wireRadio();
  press({ closest: () => null }); // LISTEN, a band chip, anything but a group
  assert.deepEqual(calls, [["tune", 1]], "the radio still tunes from a focused button");
  press({ closest: (sel) => (sel.includes("input") ? {} : null) });
  assert.deepEqual(calls, [["tune", 1]], "a text field keeps them quiet");
});

test("a group the page is building keeps its own arrow keys", () => {
  const calls = wireRadio();
  press(inGroup("radiogroup"));
  assert.deepEqual(calls, [], "the ORDER radiogroup owns its arrow keys");
  press(inGroup("listbox"));
  assert.deepEqual(calls, [], "a listbox owns its arrow keys too");
});

// ---- 3. the crew manifest's PUSH (aboard.js) -------------------------------------------------
test("PUSH boards the manifest's room by its own link once that room has left the dial", () => {
  const gone = { id: "1YqKDqWqdPLxV", title: "Night owls" };
  const here = { id: "1OwxWzXyLbJQ", title: "Morning show" };
  let state = { air: { phase: "idle", roomId: null }, currentId: here.id, rosters: {}, ended: [], learned: { crew: true } };
  const calls = [];
  const note = (name) => (...args) => { calls.push([name, ...args]); };
  const app = {
    get state() { return state; },
    device: { kind: "desktop" },
    current: () => [here].find((r) => r.id === state.currentId) || null,
    deck: () => [here], // a refresh dropped the manifest's room off the band
    select: (id) => { state = { ...state, currentId: id }; calls.push(["select", id]); },
    copy: () => ({ ptt: { text: "PUSH TO LISTEN", sub: "", mode: "intercept" }, here: false, linedUp: false }),
    channelLabel: () => "CH 01 · 88.1 FM", set: note("set"), step: note("step"), render: note("render"), sfxOk: () => false,
  };
  const launch = { push: note("push"), leaveForX: note("leaveForX") };

  const opts = crewOptions(app, launch, gone);
  const click = { preventDefault: note("preventDefault") };
  opts.listen.onClick(click);

  assert.deepEqual(calls, [], "the dial does not hold that room, so nothing is selected and X is left to the link");
  assert.equal(state.currentId, here.id, "the needle stays on the room the dial holds");
  assert.equal(opts.listen.href, `https://x.com/i/spaces/${gone.id}`, "the link still names the manifest's room");
});
