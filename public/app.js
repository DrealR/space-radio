// Spaces Radio SR-26. State is replaced, never edited in place; render() draws it.
import {
  GRILLE_DOTS, MAX_PRESETS, addPreset, ago, bandLabel, buildDeck, frequency, grillePlan,
  parseSpaceId, position, removePreset, signalBars,
} from "./js/rooms.js";
import { joinCopy, qrSvg } from "./js/handoff.js";
import { rogerBeep, staticBurst } from "./js/sfx.js";

const WINDOW_NAME = "spaces-radio";
const HUNT_URL = "https://x.com/search?q=%22x.com%2Fi%2Fspaces%22&f=live";
const PREFS_KEY = "spaces-radio:prefs";
const PRESETS_KEY = "spaces-radio:presets";
const REFRESH_MS = 10 * 60000;
const KNOB_STEP_DEG = 36;
const DRAG_STEP_PX = 34;
const SWIPE_PX = 40;

const $ = (id) => document.getElementById(id);
const coarse = window.matchMedia("(pointer: coarse)").matches;

let state = {
  bands: [], band: "anything", live: [], presets: [], sort: "busy", currentId: null,
  listening: false, scan: false, scanMin: 5, scanAt: 0, sfx: true, liveSearch: false,
  loading: true, problems: [], flash: "", turn: 0,
};
let listenWindow = null;
let flashTimer = 0;
let userActed = false; // browsers only allow sound after a tap or key press

const set = (patch) => { state = { ...state, ...patch }; render(); };
const deck = () => buildDeck(state.live, state.sort, state.presets);
function currentIndex(d = deck()) {
  const i = d.findIndex((r) => r.id === state.currentId);
  return i < 0 ? 0 : i;
}
const current = () => deck()[currentIndex()] || null;

// ---- storage (per browser, optional) ---------------------------------------
function readJson(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
}
function writeJson(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private window */ }
}
const savePrefs = () => writeJson(PREFS_KEY, { band: state.band, sort: state.sort, scanMin: state.scanMin, sfx: state.sfx });

async function api(path) {
  try {
    const res = await fetch(path);
    const body = await res.json();
    return body.success ? { data: body.data, meta: body.meta || {} } : { error: body.error || "Something went wrong." };
  } catch {
    return { error: "The radio can't reach its tower right now." };
  }
}

// ---- tuning ------------------------------------------------------------------
function flash(text) {
  clearTimeout(flashTimer);
  set({ flash: text });
  flashTimer = setTimeout(() => set({ flash: "" }), 2200);
}

function crackle() {
  if (state.sfx && userActed) staticBurst();
  const lcd = $("lcd");
  lcd.classList.remove("static");
  void lcd.offsetWidth; // restart the jitter animation
  lcd.classList.add("static");
}

function select(id, { quiet = false } = {}) {
  const d = deck();
  const from = currentIndex(d);
  const to = Math.max(0, d.findIndex((r) => r.id === id));
  if (!quiet && d.length) crackle();
  set({ currentId: id, turn: state.turn + (to - from) * KNOB_STEP_DEG,
        scanAt: state.scan && state.listening ? Date.now() + state.scanMin * 60000 : 0 });
  if (state.listening && !coarse) join(current());
}

function step(delta) {
  const d = deck();
  if (d.length < 2) return;
  const i = (currentIndex(d) + delta + d.length) % d.length;
  crackle();
  set({ currentId: d[i].id, turn: state.turn + delta * KNOB_STEP_DEG,
        scanAt: state.scan && state.listening ? Date.now() + state.scanMin * 60000 : 0 });
  if (state.listening && !coarse) join(current());
}

/** Desktop: open one listening window and steer it. Phone: the link opens the X app itself. */
function join(room) {
  if (!room) return false;
  if (!coarse) {
    if (listenWindow && !listenWindow.closed) listenWindow.location.href = room.url;
    else listenWindow = window.open(room.url, WINDOW_NAME);
    if (!listenWindow) {
      set({ problems: ["Your browser blocked the listening window. Allow pop-ups for this page."] });
      return false;
    }
  }
  set({ listening: true, scanAt: state.scan ? Date.now() + state.scanMin * 60000 : 0 });
  return true;
}

async function tuneBand(band, { refresh = false } = {}) {
  const switching = !refresh;
  if (switching) {
    crackle();
    set({ band, live: [], loading: true, problems: [] });
    savePrefs();
  }
  const res = await api(`/api/tune?station=${encodeURIComponent(band)}`);
  if (res.error) return set({ loading: false, problems: [res.error] });
  const keepId = switching ? null : state.currentId;
  const live = res.data;
  const stillThere = keepId && buildDeck(live, state.sort, state.presets).some((r) => r.id === keepId);
  set({ live, loading: false, problems: res.meta.problems || [],
        currentId: stillThere ? keepId : buildDeck(live, state.sort, state.presets)[0]?.id ?? null });
  if (switching && state.listening && !coarse) join(current());
}

function tick() {
  if (state.listening && !coarse && listenWindow && listenWindow.closed) {
    listenWindow = null;
    set({ listening: false, scanAt: 0 });
  }
  if (state.scan && state.listening && state.scanAt && Date.now() >= state.scanAt) step(1);
}

// ---- presets -----------------------------------------------------------------
function storePresets(presets) {
  writeJson(PRESETS_KEY, presets);
  set({ presets });
}

function keepCurrent() {
  const room = current();
  if (!room) return;
  const { presets, error } = addPreset(state.presets, room.id, room.title);
  if (error) return flash(error.toUpperCase());
  storePresets(presets);
  flash(`SAVED TO P${presets.length}`);
}

function programPreset(event) {
  event.preventDefault();
  const id = parseSpaceId($("add-link").value);
  if (!id) { $("add-msg").textContent = "That isn't a Space link (x.com/i/spaces/…)."; return; }
  const { presets, error } = addPreset(state.presets, id, $("add-title").value.trim());
  $("add-msg").textContent = error || `Programmed to P${presets.length}.`;
  if (error) return;
  event.target.reset();
  storePresets(presets);
}

// ---- handoff to phone (the web can listen; only the X app can talk) ------------
function openHandoff() {
  const room = current();
  if (!room) return;
  if (state.sfx) rogerBeep();
  $("handoff-room").textContent = room.title;
  try {
    $("handoff-qr").replaceChildren(qrSvg(room.url));
  } catch (err) {
    console.warn("[spaces-radio] QR failed", err);
    $("handoff-qr").replaceChildren(el("p", { textContent: room.url }));
  }
  $("handoff-copy").textContent = "Copy link";
  $("handoff").showModal();
}

async function copyRoomLink() {
  const room = current();
  if (!room) return;
  try {
    await navigator.clipboard.writeText(room.url);
    $("handoff-copy").textContent = "Copied ✓";
  } catch {
    $("handoff-copy").textContent = "Copy blocked";
  }
}

// ---- drawing -------------------------------------------------------------------
function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

function renderBands() {
  $("bands").replaceChildren(...state.bands.map((name) => {
    const key = el("button", { type: "button", textContent: bandLabel(name), title: name });
    key.setAttribute("aria-pressed", String(name === state.band));
    key.addEventListener("click", () => tuneBand(name));
    return key;
  }));
}

function screenText(room, d, i) {
  if (state.loading) return { title: "SCANNING THE BAND…", info: "" };
  if (!room && !state.liveSearch) return { title: "NO SIGNAL · PROGRAM A PRESET ↓", info: "AUTO-TUNE IS OFF" };
  if (!room) return { title: "DEAD AIR ON THIS BAND", info: "TRY ANOTHER BAND" };
  if (room.source === "yours") {
    const slot = state.presets.findIndex((p) => p.id === room.id) + 1;
    return { title: room.title, info: `PRESET P${slot} · MAY HAVE ENDED` };
  }
  const bits = [`${room.listeners} IN ROOM`, room.speakers ? `${room.speakers} ON MIC` : "", ago(room.started_at),
                room.lang ? room.lang.toUpperCase() : ""];
  return { title: room.title, info: bits.filter(Boolean).join(" · ") };
}

function renderScreen(room, d, i) {
  const { title, info } = screenText(room, d, i);
  $("lcd-ch").textContent = d.length ? `CH ${String(i + 1).padStart(2, "0")}/${String(d.length).padStart(2, "0")}` : "CH --";
  $("lcd-freq").textContent = d.length ? `${frequency(i, d.length)} FM` : "--.- FM";
  $("lcd-band").textContent = bandLabel(state.band);
  const titleEl = $("lcd-title");
  if (titleEl.dataset.title !== title) {
    titleEl.dataset.title = title;
    titleEl.textContent = title;
    const box = titleEl.parentElement;
    box.classList.remove("scroll");
    requestAnimationFrame(() => {
      if (titleEl.scrollWidth <= box.clientWidth) return;
      titleEl.textContent = `${title}   ✦   ${title}   ✦   `;
      box.style.setProperty("--dur", `${Math.max(8, title.length * 0.32)}s`);
      box.classList.add("scroll");
    });
  }
  $("lcd-info").textContent = state.flash || (state.problems.length && !room ? "SIGNAL TROUBLE" : info);
  const bars = signalBars(room?.listeners);
  [...$("lcd-signal").children].forEach((bar, k) => bar.classList.toggle("on", k < bars));
}

function renderGlass(d, i) {
  const max = Math.max(1, ...d.map((r) => r.listeners || 0));
  $("markers").replaceChildren(...d.map((room, k) => {
    const size = room.listeners == null ? 0.4 : 0.18 + 0.82 * Math.log1p(room.listeners) / Math.log1p(max);
    const mark = el("button", { type: "button", title: room.title, className: room.source === "yours" ? "mine" : "" });
    mark.setAttribute("aria-label", `Channel ${k + 1}: ${room.title}`);
    mark.style.left = `${position(k, d.length)}%`;
    mark.style.height = `${Math.round(size * 100)}%`;
    mark.classList.toggle("at", k === i);
    mark.addEventListener("click", (e) => { e.stopPropagation(); select(room.id); });
    return mark;
  }));
  const glass = $("glass");
  glass.classList.toggle("empty", !d.length);
  // The markers box is inset 12px each side; line the needle up with it.
  $("needle").style.left = d.length ? `calc(12px + (100% - 24px) * ${position(i, d.length) / 100})` : "";
}

function renderGrille(room) {
  const plan = grillePlan(room);
  const grille = $("grille");
  if (grille.children.length !== GRILLE_DOTS) grille.replaceChildren(...Array.from({ length: GRILLE_DOTS }, () => el("i")));
  [...grille.children].forEach((dot, k) => {
    dot.className = plan.cells[k];
    dot.style.animationDelay = `${(k * 137) % 1600}ms`;
  });
  grille.setAttribute("aria-label", room && plan.known
    ? `${room.listeners} people: ${room.hosts} hosting, ${room.speakers} on the mic` : "No headcount");
  $("grille-key").textContent = !room ? "" : !plan.known ? "NO HEADCOUNT FOR PRESETS"
    : plan.perDot === 1 ? "1 DOT = 1 PERSON" : `1 DOT ≈ ${plan.perDot} PEOPLE`;
}

function renderPresets(room) {
  const slots = Array.from({ length: MAX_PRESETS }, (_, k) => {
    const p = state.presets[k];
    const b = el("button", { type: "button", className: p ? "" : "empty" },
      `P${k + 1}`, el("small", { textContent: p ? p.title || "room" : "empty" }));
    if (p) {
      b.classList.toggle("at", room?.id === p.id);
      b.addEventListener("click", () => select(p.id));
    } else {
      b.disabled = true;
    }
    return b;
  });
  const keep = el("button", { type: "button", className: "keep" }, "KEEP ♥", el("small", { textContent: "save this room" }));
  keep.disabled = !room || state.presets.some((p) => p.id === room.id);
  keep.addEventListener("click", keepCurrent);
  $("presets").replaceChildren(...slots, keep);

  $("preset-list").replaceChildren(...state.presets.map((p, k) => {
    const rm = el("button", { type: "button", textContent: "clear" });
    rm.addEventListener("click", () => storePresets(removePreset(state.presets, p.id)));
    return el("li", {}, el("span", { textContent: `P${k + 1} · ${p.title || p.id}` }), rm);
  }));
}

function renderControls(room) {
  const ptt = $("ptt");
  ptt.href = room ? room.url : "#";
  ptt.classList.toggle("off", !room);
  const copy = joinCopy({ phone: coarse, listening: state.listening });
  $("ptt-text").textContent = copy.text;
  $("ptt-sub").textContent = copy.sub;
  $("mic").hidden = coarse;
  $("mic").disabled = !room;
  $("knob").style.setProperty("--turn", `${state.turn}deg`);
  document.querySelectorAll(".slide button").forEach((b) =>
    b.setAttribute("aria-checked", String(b.dataset.sort === state.sort)));
  $("lamp-rx").classList.toggle("on", Boolean(room) && !state.loading);
  $("lamp-air").classList.toggle("on", state.listening);
  $("radio").classList.toggle("live", state.listening);
  $("scan-on").checked = state.scan;
  $("sfx-on").checked = state.sfx;
}

function renderFoot() {
  const trouble = state.problems.length ? ` Trouble: ${state.problems.join(" ")}` : "";
  $("foot").textContent = (state.liveSearch
    ? "Auto-tune is on. Live rooms come from the X API and are shared by every listener, refreshed every 10 minutes."
    : "Auto-tune is off: this radio has no X API key yet, so it plays the presets you program.") + trouble;
}

function render() {
  const d = deck();
  const i = currentIndex(d);
  const room = d[i] || null;
  renderBands();
  renderScreen(room, d, i);
  renderGlass(d, i);
  renderGrille(room);
  renderPresets(room);
  renderControls(room);
  renderFoot();
}

// ---- wiring --------------------------------------------------------------------
function onSwipe(node, handler) {
  let start = null;
  node.addEventListener("pointerdown", (e) => { start = { x: e.clientX, y: e.clientY }; });
  node.addEventListener("pointerup", (e) => {
    if (!start) return;
    const dx = e.clientX - start.x;
    const dy = e.clientY - start.y;
    start = null;
    if (Math.abs(dx) > SWIPE_PX && Math.abs(dx) > Math.abs(dy)) handler(dx < 0 ? 1 : -1);
  });
}

function wireKnob() {
  const knob = $("knob");
  let drag = null;
  knob.addEventListener("pointerdown", (e) => {
    drag = { x: e.clientX, y: e.clientY, moved: 0 };
    knob.setPointerCapture(e.pointerId);
  });
  knob.addEventListener("pointermove", (e) => {
    if (!drag) return;
    const travel = (e.clientX - drag.x) - (e.clientY - drag.y);
    const steps = Math.trunc(travel / DRAG_STEP_PX);
    if (steps !== drag.moved) { step(steps - drag.moved); drag.moved = steps; }
  });
  knob.addEventListener("pointerup", () => {
    if (drag && drag.moved === 0) step(1);
    drag = null;
  });
  knob.addEventListener("pointercancel", () => { drag = null; });
  knob.addEventListener("wheel", (e) => { e.preventDefault(); step(e.deltaY > 0 ? 1 : -1); }, { passive: false });
}

function wire() {
  $("hunt").href = HUNT_URL;
  ["pointerdown", "keydown"].forEach((type) =>
    window.addEventListener(type, () => { userActed = true; }, { once: true, capture: true }));
  wireKnob();
  onSwipe($("lcd"), step);
  onSwipe($("glass"), step);
  $("ptt").addEventListener("click", (e) => {
    const room = current();
    if (!room) return e.preventDefault();
    if (state.sfx) rogerBeep();
    if (!coarse) { e.preventDefault(); join(room); } else { set({ listening: true }); }
  });
  document.querySelectorAll(".slide button").forEach((b) => b.addEventListener("click", () => {
    set({ sort: b.dataset.sort });
    savePrefs();
  }));
  $("scan-on").addEventListener("change", (e) =>
    set({ scan: e.target.checked, scanAt: e.target.checked && state.listening ? Date.now() + state.scanMin * 60000 : 0 }));
  $("scan-min").addEventListener("change", (e) => {
    const scanMin = Number(e.target.value);
    set({ scanMin, scanAt: state.scan && state.listening ? Date.now() + scanMin * 60000 : 0 });
    savePrefs();
  });
  $("sfx-on").addEventListener("change", (e) => { set({ sfx: e.target.checked }); savePrefs(); });
  $("add-form").addEventListener("submit", programPreset);
  $("mic").addEventListener("click", openHandoff);
  $("handoff-copy").addEventListener("click", copyRoomLink);
  $("handoff-close").addEventListener("click", () => $("handoff").close());
  $("handoff").addEventListener("click", (e) => { if (e.target === $("handoff")) $("handoff").close(); });
  document.addEventListener("keydown", (e) => {
    if (e.target.closest("input, select, textarea") || $("handoff").open) return;
    if (e.key === "ArrowRight" || e.key === "ArrowDown") { e.preventDefault(); step(1); }
    if (e.key === "ArrowLeft" || e.key === "ArrowUp") { e.preventDefault(); step(-1); }
  });
  if (coarse) document.querySelectorAll("#scan-on, #scan-min").forEach((n) => n.closest(".toggle, select").hidden = true);
}

async function start() {
  const prefs = readJson(PREFS_KEY, {});
  const presets = readJson(PRESETS_KEY, []).filter((p) => p && parseSpaceId(p.id));
  state = { ...state, presets, sort: prefs.sort || "busy", scanMin: prefs.scanMin || 5,
            sfx: prefs.sfx !== false };
  $("scan-min").value = String(state.scanMin);
  wire();
  render();
  const status = await api("/api/status");
  if (status.error) return set({ loading: false, problems: [status.error] });
  const bands = status.data.stations;
  set({ bands, liveSearch: status.data.live_search });
  await tuneBand(bands.includes(prefs.band) ? prefs.band : bands[0]);
  setInterval(tick, 1000);
  setInterval(() => state.liveSearch && tuneBand(state.band, { refresh: true }), REFRESH_MS);
}

start();
