// PUSH, the first of two keys: it boards the ship. X plays the sound only after its own
// ▶ Start listening press, so the radio stands by until you say you hear the room.
// Only a press gets here. The dial, band keys, SCAN and refresh never touch X.
//
// Every function takes `app`: { state, set, render, flash, say, current, deck, step, select,
// copy, learn, nextScan, sfxOk, device }. createLaunch() binds them for app.js.
// Tested in tests/launch.test.mjs.
import { AWAY_GRACE_MS, HAIL_MS, QUIET_MS, airNext, canHear } from "./airlock.js";
import { dockFeatures } from "./dock.js";
import { planPush, readWindow } from "./listener.js";
import { peekUrl, spaceUrl } from "./rooms.js";
import { aliveX, committedX, dropX, focusX, holdingX, openX, openedAtX, steerX } from "./xwindow.js";
import { clearTrip, loadTrip, returnPlan, saveTrip } from "./trip.js";
import { hail, lock, lost, rogerBeep, tick } from "./sfx.js";
import { closeCrewIfOpen } from "./aboard.js";
import { $, pulse } from "./dom.js";

const OPEN_PHASES = new Set(["airlock", "onair", "lost"]);
const modified = (e) => Boolean(e.metaKey || e.ctrlKey || e.shiftKey);

const dispatch = (app, event, patch = {}) => app.set({ ...patch, air: airNext(app.state.air, event) });
const sound = (app, play) => { if (app.sfxOk()) play(); };
const holding = (app) => ["unknown", "kept"].includes(app.state.air.handle) && aliveX();
const roomOf = (app, id) => app.deck().find((r) => r.id === id) || { id, title: app.state.airTitle };

function buzz(app, pattern) {
  if (!app.device.android) return;
  try { navigator.vibrate?.(pattern); } catch { /* no vibration motor */ }
}

function screenMetrics() {
  const s = window.screen;
  return {
    screenX: window.screenX, screenY: window.screenY, outerWidth: window.outerWidth, outerHeight: window.outerHeight,
    innerWidth: window.innerWidth, innerHeight: window.innerHeight,
    availLeft: s.availLeft || 0, availTop: s.availTop || 0, availWidth: s.availWidth, availHeight: s.availHeight,
  };
}

/** The X window as it is right now; the once-a-second watch may not have looked yet. */
const windowNow = (app, now = Date.now()) => readWindow({
  handle: app.state.air.handle, openedAt: openedAtX(), now, alive: aliveX(), committed: committedX(),
});

// ---- computer: dock X beside the radio ----------------------------------------------------
function launched(app, room, extra) {
  dispatch(app, { type: "opened", roomId: room.id, now: Date.now(), ...extra },
    { airTitle: room.title, scanAt: app.nextScan() });
  if (!app.state.learned.push) app.learn({ push: true });
  sound(app, () => { rogerBeep(); hail(); });
  buzz(app, 10);
  app.say(extra.side === "tab" ? "X opened in a new tab. Press Start listening there."
    : "X is opening beside the radio. Press Start listening there.");
  setTimeout(app.render, HAIL_MS + 30); // hailing settles into the airlock
}

function openDocked(app, room) {
  const note = OPEN_PHASES.has(app.state.air.phase) ? "stale" : "";
  const placed = app.device.dockable ? dockFeatures(screenMetrics(), $("radio").getBoundingClientRect())
    : { features: "", side: "tab" };
  if (!openX(peekUrl(room.id), placed.features)) {
    // Remembered for the session: from now on the button is a plain link, so no press is wasted.
    dispatch(app, { type: "blocked", roomId: room.id, now: Date.now() }, { popupsBlocked: true });
    return app.say("Pop-up blocked. The big button now opens the room in a new tab.");
  }
  launched(app, room, { side: placed.side, handle: "unknown", note });
}

// The browser follows a plain link after this click; change nothing until it has.
function viaLink(app, room) {
  const { phase, roomId, note: was } = app.state.air;
  const stale = (OPEN_PHASES.has(phase) && roomId !== room.id) || (phase === "blocked" && was === "stale");
  setTimeout(() => launched(app, room, { side: "tab", handle: "none", note: stale ? "stale" : "" }), 0);
}

const PLANS = {
  focus: (app) => { focusX(); app.flash("X WINDOW BROUGHT FORWARD"); },
  remind: (app, room) => {
    // Our window closed and the watch hasn't noticed yet: open it again, don't point at nothing.
    if (holdingX() && windowNow(app) === "closed") {
      dropX();
      dispatch(app, { type: "reset" });
      return openDocked(app, room);
    }
    app.flash("X IS OPEN IN ANOTHER TAB");
    app.say("This room is already open in another X tab.");
  },
  steer: (app, room) => {
    const { handle, side } = app.state.air;
    if (!steerX(peekUrl(room.id))) return openDocked(app, room);
    focusX();
    launched(app, room, { side, handle, note: "steered" });
  },
  open: openDocked,
};

/** The PTT click (and the crew footer's). Synchronous: nothing may await before window.open. */
function push(app, e) {
  const room = app.current();
  const { ptt } = app.copy();
  if (!room || ptt.mode === "off") return e.preventDefault();
  if (app.device.kind === "phone") return phonePush(app, e, room);
  if (ptt.mode === "newtab" || modified(e)) return viaLink(app, room);
  e.preventDefault();
  const { phase, roomId } = app.state.air;
  // blocked stays false: once pop-ups were blocked the copy already made this a newtab link (above).
  const plan = planPush({ kind: app.device.kind, phase, sameRoom: roomId === room.id, alive: holding(app), blocked: false });
  PLANS[plan](app, room);
}

function auxPush(app, e) {
  const room = app.current();
  if (e.button === 1 && room && app.device.kind !== "phone" && app.copy().ptt.mode !== "off") viaLink(app, room);
}

// ---- phone: a same-tab link the X app can catch -------------------------------------------
function phonePush(app, e, room) {
  if (app.state.learned.preflight) return leaveForX(app, room);
  e.preventDefault();
  $("preflight-go").href = spaceUrl(room.id);
  $("preflight").dataset.roomId = room.id;
  $("preflight").showModal();
}

/** Synchronous: the page may unload the moment this returns. */
function leaveForX(app, room) {
  saveTrip({ roomId: room.id, band: app.state.band, title: room.title, at: Date.now() });
  app.learn({ preflight: true, push: true });
  dispatch(app, { type: "away", roomId: room.id, now: Date.now() }, { airTitle: room.title });
  sound(app, rogerBeep);
  buzz(app, 20);
  // A hand-off that never hid the page (a dismissed "open with" chooser, a sheet over a
  // home-screen radio) must not leave the radio on OPENING X… with nothing to press.
  const since = app.state.air.since;
  setTimeout(() => {
    const air = app.state.air;
    if (document.visibilityState === "visible" && air.phase === "away" && air.since === since) phoneReturn(app, false);
  }, AWAY_GRACE_MS);
}

function preflightGo(app) {
  const id = $("preflight").dataset.roomId;
  if (id) leaveForX(app, roomOf(app, id));
  $("preflight").close();
}

function navType() {
  try {
    return performance.getEntriesByType("navigation")[0]?.type || "";
  } catch {
    return "";
  }
}

// X played in this very tab when the page comes back from the back/forward cache, reloads as
// a back navigation, or is the home-screen radio (links open in a sheet over it). Not on every
// reload: a discarded tab reloads while the X app keeps playing.
const playedHere = (app, e) => app.device.standalone || (e?.type === "pageshow" && e.persisted === true);

function phoneReturn(app, inTab) {
  const trip = loadTrip(Date.now());
  const plan = returnPlan(app.state.air, trip, inTab);
  if (!plan) return;
  const here = inTab || (plan === "restore" && navType() === "back_forward");
  if (plan === "restore") {
    // A cold reload: the page forgot the trip, sessionStorage didn't.
    dispatch(app, { type: "away", roomId: trip.roomId, now: trip.at }, { airTitle: trip.title });
  }
  closeCrewIfOpen(); // a crew sheet left open would cover the question
  dispatch(app, { type: "returned", now: Date.now(), inTab: here });
  app.say(here ? "X played in this tab, so coming back stopped it." : "Back on the bridge. Did the room play?");
}

function restoreTrip(app) {
  if (app.device.kind !== "phone") return;
  const trip = loadTrip(Date.now());
  if (!trip) return;
  if (app.deck().some((r) => r.id === trip.roomId)) app.select(trip.roomId, { quiet: true });
  phoneReturn(app, app.device.standalone);
}

// ---- key 2 confirmed, or not ----------------------------------------------------------------
function heard(app) {
  const before = app.state.air;
  if (!canHear(before)) return;
  const title = roomOf(app, before.roomId).title || "the room";
  dispatch(app, { type: "heard", now: Date.now() }, { scanAt: app.nextScan() });
  app.learn({ confirms: app.state.learned.confirms + 1, push: true });
  if (app.device.kind === "phone") clearTrip();
  sound(app, lock);
  pulse($("radio"), "locking", 800);
  buzz(app, [12, 50, 20]);
  app.flash("LIGHT-DELAY 0.00s · LOCKED", 1600);
  $("ptt").focus({ preventScroll: true });
  app.say(`Signal locked. You're listening to ${title}.`);
}

function stopped(app) {
  dispatch(app, { type: "stopped" });
  pulse($("lcd"), "snow", 700);
  app.say("Stopped. Push to listen again.");
}

function tabChip(app) {
  const room = roomOf(app, app.state.air.roomId);
  if (app.device.kind === "phone") return leaveForX(app, room);
  viaLink(app, room);
}

const CHIPS = {
  heard,
  stopped,
  nosound: (app) => dispatch(app, { type: "noSound" }),
  forward: (app) => app.flash(focusX() ? "X WINDOW BROUGHT FORWARD" : "X IS OPEN IN ANOTHER TAB"),
  opentab: tabChip,
  openagain: tabChip,
  reopen: (app) => openDocked(app, roomOf(app, app.state.air.roomId)),
  next: (app) => app.step(1),
};

// ---- the once-a-second watch, and coming back to the radio ------------------------------------
function windowGone(app) {
  const was = app.state.air.phase;
  dispatch(app, { type: "windowClosed" });
  if (was === "onair") {
    sound(app, lost);
    pulse($("lcd"), "snow", 700);
    app.say("Lost track of the X window.");
  } else if (was === "airlock") {
    // Often the moment X started playing (signing in can cut the link): no alarm, just ask.
    sound(app, tick);
    app.say("Lost track of the X window. Hearing the room? Press I hear it.");
  }
}

function checkWindow(app, now) {
  const seen = windowNow(app, now);
  if (seen === "kept") return dispatch(app, { type: "handleKept" });
  if (!seen) return;
  dropX();
  if (seen === "cut") return dispatch(app, { type: "handleCut" });
  windowGone(app);
}

function watch(app, now) {
  if (app.device.kind === "phone") return;
  if (holdingX()) checkWindow(app, now);
  const { phase, quietShown, since } = app.state.air;
  if (phase === "airlock" && !quietShown && now - since >= QUIET_MS && document.hasFocus()) {
    dispatch(app, { type: "quiet", now });
  }
}

function returned(app, e) {
  if (document.visibilityState === "hidden") return;
  if (app.device.kind === "phone") return phoneReturn(app, playedHere(app, e));
  const before = app.state.air;
  const next = airNext(before, { type: "returned", now: Date.now() });
  if (next.asked === before.asked) return;
  app.set({ air: next });
  // Clicking back into the page (focus) is often a press on I HEAR IT: a tick would sound like a miss.
  if (e?.type !== "focus") sound(app, tick);
  app.say("Hearing the room? Answer below.");
}

function openInX(app) {
  const url = spaceUrl(app.current()?.id);
  if (!url) return;
  window.open(url, "_blank", "noopener");
  app.flash("OPENED ON X IN A NEW TAB");
}

function openXClick(app) {
  const room = app.current();
  if (!room) return;
  if (app.device.kind === "phone") return leaveForX(app, room);
  setTimeout(() => app.flash("OPENED ON X IN A NEW TAB"), 0);
}

function dismiss(app) {
  if (app.state.air.help) dispatch(app, { type: "dismiss" });
}

/** The launch, bound to one app. */
export function createLaunch(app) {
  const bind = (fn) => (...args) => fn(app, ...args);
  const handlers = { push, auxPush, leaveForX, preflightGo, heard, watch, returned, restoreTrip, openInX, openXClick, dismiss };
  const bound = Object.fromEntries(Object.entries(handlers).map(([name, fn]) => [name, bind(fn)]));
  return Object.freeze({ ...bound, chip: (id, e) => CHIPS[id]?.(app, e) });
}
