// Space Radio SR-26. State is replaced, never edited in place; render() draws it.
// The dial browses. The button boards. X plays the sound.
import { buildDeck, frequency, onlyEnglish, parseSpaceId, spaceUrl } from "./js/rooms.js";
import { AIR_IDLE } from "./js/airlock.js";
import { airCopy } from "./js/airlock-copy.js";
import { deviceKind, dockable, inAppBrowser, isAndroid, isStandalone } from "./js/dock.js";
import { $, pulse } from "./js/dom.js";
import { say } from "./js/announce.js";
import { LEARNED_NONE, learn, loadLearned } from "./js/learned.js";
import { readJson, readRaw, writeJson, writeRaw } from "./js/store.js";
import { bootType, renderGlass, renderGrille, renderScreen } from "./js/screen.js";
import { renderLaunch } from "./js/airlock-view.js";
import { renderBands } from "./js/bands-view.js";
import { nextScanAt, scanDue } from "./js/scan.js";
import { PRESETS_KEY, programPreset, renderPresets } from "./js/presets-view.js";
import { createLaunch } from "./js/launch.js";
import { isCrewShowing, preloadCrew, showCrew } from "./js/aboard.js";
import { freshRoster, withRoster } from "./js/roster.js";
import { wireKeys } from "./js/keys.js";
import { onSwipe, wireKnob } from "./js/knob.js";
import { copyRoomLink, openHandoff } from "./js/mic.js";
import { rogerBeep, staticBurst, tick as detent } from "./js/sfx.js";
import { openRadar } from "./js/radar.js";
import { bandKey, findBand, isMine, loadBands, mergeRooms, searchPath } from "./js/mybands.js";
import { readBeam } from "./js/beam.js";
import { beamCurrent, landBeam, makeBand, MYBANDS_KEY } from "./js/bridge.js";
import { createDock } from "./js/tunnel.js";
import { readDock } from "./js/dock-model.js";

const HUNT_URL = "https://x.com/search?q=%22x.com%2Fi%2Fspaces%22&f=live";
const PREFS_KEY = "spaces-radio:prefs";
const INAPP_KEY = "spaces-radio:inapp-dismissed";
const BOOT_KEY = "spaces-radio:booted";
const REFRESH_MS = 30 * 60000; // matches the server's shared cache; every fresh search is billed
const RETRY_STATUS_MS = 60000;
const KNOB_STEP_DEG = 36;

const media = (q) => window.matchMedia(q).matches;
const touch = { coarse: media("(pointer: coarse)"), hoverNone: media("(hover: none)") };
const device = Object.freeze({
  kind: deviceKind({ ...touch, shortSide: Math.min(window.screen.width, window.screen.height) }),
  dockable: dockable(touch),
  standalone: isStandalone((q) => window.matchMedia(q), navigator),
  android: isAndroid(navigator.userAgent),
  inApp: inAppBrowser(navigator.userAgent),
});
const phone = device.kind === "phone";

let state = {
  bands: [], band: "anything", live: [], presets: [], sort: "busy", currentId: null,
  air: AIR_IDLE, airTitle: "", rosters: {}, ended: [], learned: LEARNED_NONE, popupsBlocked: false,
  scan: false, scanMin: 5, scanAt: 0, sfx: true, english: true, liveSearch: false,
  loading: true, problems: [], flash: "", turn: 0, myBands: [], beam: null,
};
let flashTimer = 0;
let userActed = false; // browsers only allow sound after a tap or key press

const set = (patch) => { state = { ...state, ...patch }; render(); };
// A beamed room rides at the end of the deck (like a preset) until it turns up live.
const withBeam = (presets) => (state.beam && !presets.some((p) => p.id === state.beam.id) ? [...presets, state.beam] : presets);
const deckFor = (live) => buildDeck(onlyEnglish(live, state.english), state.sort, withBeam(state.presets))
  .map((r) => (state.beam && r.id === state.beam.id && r.listeners == null ? { ...r, beamed: true } : r));
const deck = () => deckFor(state.live);
function currentIndex(d = deck()) {
  const i = d.findIndex((r) => r.id === state.currentId);
  return i < 0 ? 0 : i;
}
const current = () => deck()[currentIndex()] || null;
const sfxOk = () => state.sfx && userActed;
// Called as a room opens, before the phase changes: only whether SCAN is on matters here.
const nextScan = () => (state.scan ? Date.now() + state.scanMin * 60000 : 0);
const savePrefs = () => writeJson(PREFS_KEY, { band: state.band, sort: state.sort, scanMin: state.scanMin,
                                               sfx: state.sfx, english: state.english });

function channelLabel(d = deck()) {
  const i = currentIndex(d);
  return d.length ? `CH ${String(i + 1).padStart(2, "0")} · ${frequency(i, d.length)} FM` : "";
}

function copyCtx(d = deck()) {
  const i = currentIndex(d);
  const room = d[i] || null;
  const playing = d.findIndex((r) => r.id === state.air.roomId);
  return {
    kind: device.kind, dockable: device.dockable, standalone: device.standalone, android: device.android,
    hasRoom: Boolean(room), ended: Boolean(room) && state.ended.includes(room.id), now: Date.now(),
    confirms: state.learned.confirms, freq: d.length ? frequency(i, d.length) : "--.-",
    playingCh: playing < 0 ? null : playing + 1, currentId: room?.id ?? null, popupsBlocked: state.popupsBlocked,
  };
}

async function api(path) {
  try {
    const res = await fetch(path);
    const body = await res.json();
    return body.success ? { data: body.data, meta: body.meta || {} } : { error: body.error || "Something went wrong." };
  } catch {
    return { error: "The radio can't reach its tower right now." };
  }
}

// ---- tuning: lines rooms up, never touches X ----------------------------------------------
function flash(text, ms = 2200) {
  clearTimeout(flashTimer);
  set({ flash: text });
  flashTimer = setTimeout(() => set({ flash: "" }), ms);
}

function crackle() {
  if (sfxOk()) staticBurst();
  pulse($("lcd"), "static", 400);
}

function announceTune() {
  const d = deck();
  const room = d[currentIndex(d)];
  if (!room) return;
  const people = room.listeners == null ? "" : ` ${room.listeners} in the room.`;
  const copy = app.copy();
  const next = copy.linedUp ? " Lined up: push to jump." : "";
  say(`Channel ${currentIndex(d) + 1} of ${d.length}, ${frequency(currentIndex(d), d.length)} FM: ${room.title}.${people}${next}`);
}

function select(id, { quiet = false } = {}) {
  const d = deck();
  const from = currentIndex(d);
  const to = Math.max(0, d.findIndex((r) => r.id === id));
  if (!quiet && d.length) crackle();
  clearTimeout(flashTimer);
  set({ currentId: id, turn: state.turn + (to - from) * KNOB_STEP_DEG, flash: "" });
  if (!quiet) announceTune();
}

function step(delta) {
  const d = deck();
  if (d.length < 2) return;
  const i = (currentIndex(d) + delta + d.length) % d.length;
  crackle();
  clearTimeout(flashTimer); // a new room: old news leaves the screen
  set({ currentId: d[i].id, turn: state.turn + delta * KNOB_STEP_DEG, flash: "" });
  announceTune();
}

async function fetchBand(band) {
  if (!isMine(band)) return api(`/api/tune?station=${encodeURIComponent(band)}`);
  const mine = findBand(state.myBands, band);
  if (!mine) return { error: "That band was cleared." };
  const answers = await Promise.all(mine.words.map((w) => api(searchPath(w))));
  const good = answers.filter((a) => !a.error);
  if (!good.length) return { error: answers[0]?.error || "No answer for your band." };
  const problems = answers.filter((a) => a.error).map((a) => a.error);
  return { data: mergeRooms(good.map((a) => (Array.isArray(a.data) ? a.data : []))), meta: { problems } };
}

async function tuneBand(band, { refresh = false } = {}) {
  const switching = !refresh;
  if (switching) {
    crackle();
    set({ band, live: [], loading: true, problems: [] });
    savePrefs();
  }
  const res = await fetchBand(band);
  if (res.error) return set({ loading: false, problems: [res.error] });
  const keepId = switching ? null : state.currentId;
  const live = Array.isArray(res.data) ? res.data.filter((r) => r && parseSpaceId(r.id) === r.id) : [];
  const next = deckFor(live);
  const stillThere = keepId && next.some((r) => r.id === keepId);
  set({ live, loading: false, problems: res.meta.problems || [],
        currentId: stillThere ? keepId : next[0]?.id ?? null });
  if (switching) announceTune();
}

function tick() {
  const now = Date.now();
  launch.watch(now);
  const { scan, scanAt, air } = state;
  if (!scanDue({ scan, phase: air.phase, scanAt, now, crewOpen: isCrewShowing() })) return;
  // SCAN only lines the next ship up; you push to jump.
  step(1);
  if (sfxOk()) rogerBeep();
  flash("NEXT SHIP LINED UP · PUSH");
  say("Next ship lined up. Push to jump.");
  set({ scanAt: nextScan() });
}

// ---- drawing ------------------------------------------------------------------------------
function renderSpeaker(room) {
  const speaker = $("speaker");
  speaker.disabled = !room;
  const people = room?.listeners == null ? "" : `${room.listeners} aboard. `;
  speaker.setAttribute("aria-label", room ? `${people}See who's here` : "No room tuned");
  speaker.classList.toggle("fresh", !state.learned.crew);
  $("beam").hidden = !room;
  const openX = $("open-x");
  openX.hidden = !room;
  openX.href = (room && spaceUrl(room.id)) || "#";
}

function renderControls() {
  $("mic").hidden = phone;
  $("mic").disabled = !current();
  $("knob").style.setProperty("--turn", `${state.turn}deg`);
  document.querySelectorAll(".slide button").forEach((b) =>
    b.setAttribute("aria-checked", String(b.dataset.sort === state.sort)));
  $("lamp-rx").classList.toggle("on", Boolean(current()) && !state.loading);
  $("scan-on").checked = state.scan;
  $("sfx-on").checked = state.sfx;
  $("en-on").checked = state.english;
  const trouble = state.problems.length ? ` Trouble: ${state.problems.join(" ")}` : "";
  $("foot").textContent = (state.liveSearch
    ? "Auto-tune is on. Live rooms come from the X API and are shared by every listener, refreshed every 10 minutes."
    : "Auto-tune is off: this radio has no X API key yet, so it plays the presets you program.") + trouble;
}

function render() {
  const d = deck();
  const i = currentIndex(d);
  const room = d[i] || null;
  const shown = withRoster(room, state.rosters);
  const copy = airCopy(state.air, copyCtx(d));
  renderBands(state.bands, state.band, tuneBand, {
    mine: state.myBands.map((b) => ({ key: bandKey(b), words: b.words })), onAdd: () => makeBand(app) });
  renderScreen({ room: shown, d, i, state, lcd: copy.lcd, host: room && freshRoster(state.rosters, room.id)?.host });
  renderGlass(d, i, { onSelect: select, playing: state.air.phase === "onair" ? state.air.roomId : null, ended: state.ended });
  renderGrille(shown);
  renderSpeaker(shown);
  renderPresets(app, room);
  renderLaunch(copy, { air: state.air, room, learned: state.learned, title: state.airTitle,
                       onChip: (id, e) => launch.chip(id, e) });
  renderControls();
  tunnel.draw(); // shows your current room (the tunnel exists before start() first renders)
}

// The modules below see the app through this one door.
const app = {
  get state() { return state; },
  device, set, render, flash, say, current, deck, step, select, sfxOk, nextScan, channelLabel, tuneBand,
  copy: () => airCopy(state.air, copyCtx()),
  learn: (patch) => set({ learned: learn(state.learned, patch) }),
};
const launch = createLaunch(app);
const openCrew = () => showCrew(app, launch);
const tunnel = createDock(app);
const showRadar = () => openRadar({ rooms: deck(), currentId: current()?.id, band: state.band, partner: tunnel.partnerRoom() },
  (id) => select(id));

// ---- wiring -------------------------------------------------------------------------------
function showManual() {
  const manual = document.querySelector(".manual");
  manual.scrollIntoView({ behavior: "smooth", block: "start" });
  pulse(manual, "lit", 1600);
}

function wireInApp() {
  if (!device.inApp || readRaw(INAPP_KEY)) return;
  $("inapp").hidden = false;
  $("inapp-close").addEventListener("click", () => {
    $("inapp").hidden = true;
    writeRaw(INAPP_KEY, "1");
  });
}

function wireLaunch() {
  $("ptt").addEventListener("click", launch.push);
  $("ptt").addEventListener("auxclick", launch.auxPush);
  $("preflight-go").addEventListener("click", launch.preflightGo);
  $("preflight-close").addEventListener("click", () => $("preflight").close());
  $("speaker").addEventListener("click", openCrew);
  $("radar-btn").addEventListener("click", showRadar);
  $("beam").addEventListener("click", () => beamCurrent(app));
  $("dock-btn").addEventListener("click", () => tunnel.open());
  $("open-x").addEventListener("click", launch.openXClick);
  $("open-x").title = "The room on X: everyone aboard. To listen with the radio, use PUSH.";
  if (phone) $("open-x").removeAttribute("target");
  window.addEventListener("focus", launch.returned);
  window.addEventListener("pageshow", launch.returned);
  document.addEventListener("visibilitychange", launch.returned);
  wireKeys({
    blocked: () => Boolean(document.querySelector("dialog[open]")) || isCrewShowing(),
    tune: step, push: () => $("ptt").click(), heard: launch.heard, crew: openCrew, radar: showRadar,
    openX: launch.openInX, manual: showManual, escape: launch.dismiss,
  });
}

function wireControls() {
  document.querySelectorAll(".slide button").forEach((b) => b.addEventListener("click", () => {
    set({ sort: b.dataset.sort });
    savePrefs();
  }));
  const scanAtFor = (scan, minutes) => nextScanAt({ scan, phase: state.air.phase, now: Date.now(), minutes });
  $("scan-on").addEventListener("change", (e) =>
    set({ scan: e.target.checked, scanAt: scanAtFor(e.target.checked, state.scanMin) }));
  $("scan-min").addEventListener("change", (e) => {
    const scanMin = Number(e.target.value);
    set({ scanMin, scanAt: scanAtFor(state.scan, scanMin) });
    savePrefs();
  });
  $("sfx-on").addEventListener("change", (e) => { set({ sfx: e.target.checked }); savePrefs(); });
  $("en-on").addEventListener("change", (e) => { set({ english: e.target.checked }); savePrefs(); });
  $("add-form").addEventListener("submit", (e) => programPreset(app, e));
  $("mic").addEventListener("click", () => { if (state.sfx) rogerBeep(); openHandoff(current()); });
  $("handoff-copy").addEventListener("click", () => copyRoomLink(current()));
  $("handoff-close").addEventListener("click", () => $("handoff").close());
  $("handoff").addEventListener("click", (e) => { if (e.target === $("handoff")) $("handoff").close(); });
  $("tips-again").addEventListener("click", () => { set({ learned: learn(LEARNED_NONE, {}) }); flash("TIPS ARE BACK ON"); });
  if (phone) document.querySelectorAll("#scan-on, #scan-min").forEach((n) => { n.closest(".toggle, select").hidden = true; });
}

function wire() {
  document.documentElement.dataset.kind = device.kind;
  $("hunt").href = HUNT_URL;
  ["pointerdown", "keydown"].forEach((type) =>
    window.addEventListener(type, () => { userActed = true; }, { once: true, capture: true }));
  wireKnob($("knob"), step, () => {
    if (sfxOk()) detent();
    if (device.android) navigator.vibrate?.(6);
  });
  onSwipe($("lcd"), step);
  onSwipe($("glass"), step);
  wireLaunch();
  wireControls();
  wireInApp();
}

function boot() {
  if (readRaw(BOOT_KEY, "session") || media("(prefers-reduced-motion: reduce)")) return;
  writeRaw(BOOT_KEY, "1", "session");
  bootType("SR-26 · SYSTEMS CHECK", render);
}

async function start() {
  const prefs = readJson(PREFS_KEY, {});
  const saved = readJson(PRESETS_KEY, []);
  const presetList = (Array.isArray(saved) ? saved : []).filter((p) => p && parseSpaceId(p.id) === p.id);
  state = { ...state, presets: presetList, learned: loadLearned(), sort: prefs.sort || "busy",
            myBands: loadBands(readJson(MYBANDS_KEY, [])),
            scanMin: prefs.scanMin || 5, sfx: prefs.sfx !== false, english: prefs.english !== false };
  $("scan-min").value = String(state.scanMin);
  wire();
  boot();
  render();
  setInterval(tick, 1000); // the X-window watch runs whatever the tower says
  await tuneIn(prefs);
  launch.restoreTrip();
}

// Asks the tower for its bands. On failure the presets still play, and it asks again later.
async function tuneIn(prefs) {
  const status = await api("/api/status");
  if (status.error) {
    set({ loading: false, problems: [status.error] });
    setTimeout(() => tuneIn(prefs), RETRY_STATUS_MS);
    return;
  }
  const bands = status.data.stations;
  set({ bands, liveSearch: status.data.live_search, problems: [] });
  const known = (b) => bands.includes(b) || Boolean(findBand(state.myBands, b));
  const beam = readBeam(location.search, (b) => bands.includes(b));
  await tuneBand(beam?.band || (known(prefs.band) ? prefs.band : bands[0]));
  if (beam) landBeam(app, beam);
  // A docking link opens the tunnel; otherwise a reload picks up this tab's dock, if any.
  const dockToken = readDock(location.search);
  if (dockToken) {
    history.replaceState(null, "", location.pathname);
    tunnel.join(dockToken);
  } else {
    tunnel.restore();
  }
  preloadCrew();
  // Refresh only while someone can see the radio: a hidden tab never spends.
  setInterval(() => state.liveSearch && !document.hidden && tuneBand(state.band, { refresh: true }), REFRESH_MS);
}

start();
