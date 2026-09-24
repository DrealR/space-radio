// node --test tests/*.mjs — the launch itself: what one press, one return, one tick does.
// Fakes stand in for the page, the X window and the clock; the state machine and copy are real.
import test, { afterEach, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";
import { AIR_IDLE, ASK_MS, AWAY_GRACE_MS } from "../public/js/airlock.js";
import { airCopy } from "../public/js/airlock-copy.js";
import { ISOLATION_MS } from "../public/js/listener.js";
import { peekUrl } from "../public/js/rooms.js";
import { TRIP_KEY, TRIP_MAX_MS } from "../public/js/trip.js";
import { dropX, holdingX } from "../public/js/xwindow.js";
import { createLaunch } from "../public/js/launch.js";

const A = { id: "1YqKDqWqdPLxV", title: "Night owls" };
const B = { id: "1OwxWzqXyLbJQ", title: "Morning show" };
const T0 = 1_800_000_000_000;

function recorder() {
  let items = [];
  return { add: (x) => { items = [...items, x]; }, get all() { return items; }, get last() { return items.at(-1); } };
}

/** A pop-up X window. committed: X's page has loaded, so reading its address throws. */
function fakeWin({ committed = true, steerThrows = false } = {}) {
  const win = { closed: false, focused: 0, steeredTo: null };
  win.focus = () => { win.focused += 1; };
  win.location = {
    get href() { if (committed) throw new Error("SecurityError"); return "about:blank"; },
    set href(url) { if (steerThrows) throw new Error("SecurityError"); win.steeredTo = url; },
  };
  return win;
}

function fakeNode(id) {
  return {
    id, dataset: {}, href: "", open: false, focused: 0, offsetWidth: 0,
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    focus() { this.focused += 1; }, showModal() { this.open = true; }, close() { this.open = false; },
    getBoundingClientRect: () => ({ left: 282, right: 722, top: 72, width: 440 }),
  };
}

let opened;   // every window.open call
let nextWin;  // what window.open returns next
let stored;   // sessionStorage contents

beforeEach(() => {
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: T0 });
  dropX();
  opened = recorder();
  nextWin = () => fakeWin();
  stored = new Map();
  const nodes = new Map();
  globalThis.document = {
    visibilityState: "visible", activeElement: null, hasFocus: () => true,
    getElementById: (id) => nodes.get(id) || nodes.set(id, fakeNode(id)).get(id),
  };
  globalThis.window = {
    open: (...args) => { opened.add(args); return nextWin(); },
    screen: { availLeft: 0, availTop: 25, availWidth: 1440, availHeight: 875 },
    screenX: 0, screenY: 0, outerWidth: 1440, outerHeight: 875, innerWidth: 1440, innerHeight: 795,
  };
  globalThis.sessionStorage = {
    getItem: (k) => (stored.has(k) ? stored.get(k) : null),
    setItem: (k, v) => { stored = new Map([...stored, [k, String(v)]]); },
    removeItem: (k) => { stored = new Map([...stored].filter(([key]) => key !== k)); },
  };
});

afterEach(() => {
  mock.timers.reset();
  mock.restoreAll();
  dropX();
});

function radio({ kind = "desktop", standalone = false, learned = {}, currentId = A.id, air = AIR_IDLE } = {}) {
  let state = {
    air, airTitle: "", band: "music", popupsBlocked: false, currentId, scan: false,
    learned: { push: false, confirms: 0, preflight: false, crew: false, ...learned },
  };
  const log = { flash: recorder(), say: recorder(), steps: recorder() };
  const device = { kind, dockable: kind !== "phone", standalone, android: false };
  const app = {
    get state() { return state; },
    set: (patch) => { state = { ...state, ...patch }; },
    render: () => {},
    flash: (text) => log.flash.add(text),
    say: (text) => log.say.add(text),
    current: () => [A, B].find((r) => r.id === state.currentId) || null,
    deck: () => [A, B],
    step: (d) => log.steps.add(d),
    select: (id) => { state = { ...state, currentId: id }; },
    copy: () => airCopy(state.air, {
      kind, dockable: device.dockable, standalone, android: false, hasRoom: true, ended: false,
      now: Date.now(), confirms: state.learned.confirms, freq: "96.3", playingCh: null,
      currentId: state.currentId, popupsBlocked: state.popupsBlocked,
    }),
    learn: (patch) => { state = { ...state, learned: { ...state.learned, ...patch } }; },
    nextScan: () => 0,
    sfxOk: () => false,
    device,
  };
  return { app, log, launch: createLaunch(app), get air() { return state.air; }, get state() { return state; } };
}

function click(extra = {}) {
  let prevented = false;
  return { ...extra, preventDefault: () => { prevented = true; }, get prevented() { return prevented; } };
}

test("desktop push: X opens docked at /peek, synchronously, and the radio stands by", () => {
  const r = radio();
  const e = click();
  r.launch.push(e);
  assert.equal(e.prevented, true);
  assert.equal(opened.all.length, 1);
  const [url, name, features] = opened.last;
  assert.deepEqual([url, name], [peekUrl(A.id), "sr-x"]);
  assert.match(features, /^popup=yes,width=440,/);
  assert.deepEqual([r.air.phase, r.air.handle, r.air.side, r.air.roomId], ["airlock", "unknown", "right", A.id]);
  assert.match(r.log.say.last, /beside the radio/);
  assert.equal(r.state.learned.push, true);
});

test("a blocked pop-up is remembered: the next room goes straight to a plain link", () => {
  const r = radio();
  nextWin = () => null;
  r.launch.push(click());
  assert.deepEqual([r.air.phase, r.state.popupsBlocked], ["blocked", true]);
  assert.match(r.log.say.last, /new tab/);

  r.app.select(B.id);
  assert.equal(r.app.copy().ptt.mode, "newtab");
  const e = click();
  r.launch.push(e);
  assert.equal(e.prevented, false); // the link's own target=_blank opens it
  assert.equal(opened.all.length, 1); // no second, wasted window.open
  mock.timers.tick(0);
  assert.deepEqual([r.air.phase, r.air.side, r.air.handle, r.air.roomId], ["airlock", "tab", "none", B.id]);
});

test("a modified click is the browser's: no preventDefault, no window.open, state after it", () => {
  const r = radio();
  const e = click({ metaKey: true });
  r.launch.push(e);
  assert.equal(e.prevented, false);
  assert.equal(opened.all.length, 0);
  assert.equal(r.air.phase, "idle");
  mock.timers.tick(0);
  assert.deepEqual([r.air.phase, r.air.side, r.air.handle], ["airlock", "tab", "none"]);
});

test("same room, window ours: bring it forward, never reload or open a second", () => {
  const r = radio();
  const win = fakeWin();
  nextWin = () => win;
  r.launch.push(click());
  r.launch.push(click());
  assert.equal(opened.all.length, 1);
  assert.equal(win.focused, 1);
  assert.equal(r.log.flash.last, "X WINDOW BROUGHT FORWARD");
});

test("same room, open in a tab we can't reach: say so instead of opening it twice", () => {
  const r = radio({ air: { ...AIR_IDLE, phase: "airlock", roomId: A.id, handle: "none", side: "tab", since: T0 } });
  r.launch.push(click());
  assert.equal(opened.all.length, 0);
  assert.equal(r.log.flash.last, "X IS OPEN IN ANOTHER TAB");
});

test("same room, but our window closed before the watch noticed: open it again", () => {
  const r = radio();
  const win = fakeWin();
  nextWin = () => win;
  r.launch.push(click());
  mock.timers.tick(ISOLATION_MS);
  r.launch.watch(Date.now());
  assert.equal(r.air.handle, "kept");
  win.closed = true;
  r.launch.push(click());
  assert.equal(opened.all.length, 2);
  assert.deepEqual([r.air.phase, r.air.note], ["airlock", ""]);
});

test("another room: steer the window we hold; if X won't be steered, open a fresh one", () => {
  const r = radio();
  const win = fakeWin();
  nextWin = () => win;
  r.launch.push(click());
  r.app.select(B.id);
  r.launch.push(click());
  assert.equal(win.steeredTo, peekUrl(B.id));
  assert.deepEqual([r.air.roomId, r.air.note, opened.all.length], [B.id, "steered", 1]);

  mock.method(console, "warn", () => {}); // xwindow says it couldn't steer: expected here
  const stubborn = radio();
  nextWin = () => fakeWin({ steerThrows: true });
  stubborn.launch.push(click());
  stubborn.app.select(B.id);
  stubborn.launch.push(click());
  assert.equal(opened.all.length, 3);
  assert.deepEqual([stubborn.air.roomId, stubborn.air.note], [B.id, "stale"]);
});

test("the watch: gone before we kept it is a cut; gone after is lost, and nothing claims it stopped", () => {
  const cut = radio();
  const w1 = fakeWin();
  nextWin = () => w1;
  cut.launch.push(click());
  w1.closed = true;
  mock.timers.tick(500);
  cut.launch.watch(Date.now());
  assert.deepEqual([cut.air.phase, cut.air.handle, holdingX()], ["airlock", "cut", false]);

  const lost = radio();
  const w2 = fakeWin();
  nextWin = () => w2;
  lost.launch.push(click());
  mock.timers.tick(ISOLATION_MS);
  lost.launch.watch(Date.now());
  w2.closed = true;
  lost.launch.watch(Date.now());
  assert.deepEqual([lost.air.phase, lost.air.wasOnAir, holdingX()], ["lost", false, false]);
  assert.match(lost.log.say.last, /Hearing the room\? Press I hear it/);
  assert.deepEqual(lost.app.copy().panel.chips.map((c) => c.id), ["heard", "stopped"]);
});

test("a slow X page (still blank after the grace period) is not kept yet", () => {
  const r = radio();
  nextWin = () => fakeWin({ committed: false });
  r.launch.push(click());
  mock.timers.tick(ISOLATION_MS + 2000);
  r.launch.watch(Date.now());
  assert.equal(r.air.handle, "unknown");
});

test("desktop return asks once, after a while, without touching the card", () => {
  const r = radio();
  r.launch.push(click());
  r.launch.returned({ type: "focus" });
  assert.equal(r.air.asked, false);
  mock.timers.tick(ASK_MS);
  r.launch.returned({ type: "focus" });
  assert.equal(r.air.asked, true);
  assert.equal(r.log.say.last, "Hearing the room? Answer below.");
  const said = r.log.say.all.length;
  r.launch.returned({ type: "visibilitychange" });
  assert.equal(r.log.say.all.length, said);
});

test("I HEAR IT counts from the airlock only, and a phone forgets its trip", () => {
  const idle = radio();
  idle.launch.heard();
  assert.equal(idle.air.phase, "idle");

  const r = radio();
  r.launch.push(click());
  r.launch.heard();
  assert.equal(r.air.phase, "onair");
  assert.equal(r.state.learned.confirms, 1);
  assert.equal(r.log.flash.last, "LIGHT-DELAY 0.00s · LOCKED");

  const phone = radio({ kind: "phone", learned: { preflight: true } });
  phone.launch.push(click());
  phone.launch.returned({ type: "visibilitychange" });
  phone.launch.heard();
  assert.equal(phone.air.phase, "onair");
  assert.equal(stored.has(TRIP_KEY), false);
});

test("phone, first tap: the preflight sheet, not a navigation", () => {
  const r = radio({ kind: "phone" });
  const e = click();
  r.launch.push(e);
  assert.equal(e.prevented, true);
  assert.equal(document.getElementById("preflight").open, true);
  assert.equal(document.getElementById("preflight-go").href, `https://x.com/i/spaces/${A.id}`);
  assert.equal(r.air.phase, "idle");
});

test("phone, later taps: the button's own link goes, and the trip rides in sessionStorage", () => {
  const r = radio({ kind: "phone", learned: { preflight: true } });
  const e = click();
  r.launch.push(e);
  assert.equal(e.prevented, false);
  assert.equal(r.air.phase, "away");
  assert.equal(JSON.parse(stored.get(TRIP_KEY)).roomId, A.id);
});

test("phone: a long listen still comes back to the bridge (memory wins over an expired trip)", () => {
  const r = radio({ kind: "phone", learned: { preflight: true } });
  r.launch.push(click());
  mock.timers.tick(TRIP_MAX_MS + 60_000);
  r.launch.returned({ type: "visibilitychange" });
  assert.deepEqual([r.air.phase, r.air.inTab], ["back", false]);
  assert.match(r.log.say.last, /Did the room play/);
});

test("phone: a hand-off that never hid the page moves on by itself", () => {
  const r = radio({ kind: "phone", learned: { preflight: true } });
  r.launch.push(click());
  mock.timers.tick(AWAY_GRACE_MS - 1);
  assert.equal(r.air.phase, "away");
  mock.timers.tick(1);
  assert.equal(r.air.phase, "back");
});

test("phone: back from the back/forward cache means X played in this tab, and stopped", () => {
  const r = radio({ kind: "phone", learned: { preflight: true } });
  r.launch.push(click());
  r.launch.returned({ type: "visibilitychange" });
  r.launch.returned({ type: "pageshow", persisted: true });
  assert.deepEqual([r.air.phase, r.air.inTab], ["back", true]);
  r.launch.heard();
  assert.equal(r.air.phase, "back");
  assert.match(r.log.say.last, /played in this tab/);
});

test("phone, cold reload: the stored trip brings the question back", () => {
  stored = new Map([[TRIP_KEY, JSON.stringify({ roomId: B.id, band: "music", title: B.title, at: T0 - 60_000 })]]);
  const r = radio({ kind: "phone" });
  r.launch.restoreTrip();
  assert.deepEqual([r.air.phase, r.air.roomId, r.state.currentId], ["back", B.id, B.id]);
  assert.match(r.log.say.last, /Did the room play/);
});
