// Spaces Radio dial. State is replaced, never edited in place; render() draws it.
"use strict";

const WINDOW_NAME = "spaces-radio";
const HUNT_URL = "https://x.com/search?q=%22x.com%2Fi%2Fspaces%22&f=live";
const STORE_KEY = "spaces-radio:prefs";

const $ = (id) => document.getElementById(id);
let state = { station: "anything", stations: [], rooms: [], index: 0, playing: false,
              drift: false, driftMin: 5, driftAt: 0, liveSearch: false, problems: [], budget: null };
let listenWindow = null;

const set = (patch) => { state = { ...state, ...patch }; render(); };
const current = () => state.rooms[state.index] || null;

function loadPrefs() {
  try { return JSON.parse(localStorage.getItem(STORE_KEY)) || {}; } catch { return {}; }
}
function savePrefs() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify({ station: state.station, driftMin: state.driftMin }));
  } catch { /* private window: prefs just don't persist */ }
}

async function api(path, options) {
  try {
    const res = await fetch(path, options);
    const body = await res.json();
    return body.success ? { data: body.data, meta: body.meta } : { error: body.error || "Something went wrong." };
  } catch (err) {
    return { error: "The radio server isn't answering. Is it running?" };
  }
}

// ---- listening ------------------------------------------------------------
function play(room) {
  if (!room) return;
  if (listenWindow && !listenWindow.closed) {
    listenWindow.location.href = room.url; // the window we opened: we may steer it
  } else {
    listenWindow = window.open(room.url, WINDOW_NAME);
  }
  if (!listenWindow) {
    set({ playing: false, problems: ["The browser blocked the listening window. Allow pop-ups for this page."] });
    return;
  }
  set({ playing: true, driftAt: state.drift ? Date.now() + state.driftMin * 60000 : 0 });
}

function step(delta) {
  if (!state.rooms.length) return;
  const index = (state.index + delta + state.rooms.length) % state.rooms.length;
  set({ index });
  if (state.playing) play(current());
}

function tick() {
  if (state.playing && listenWindow && listenWindow.closed) {
    listenWindow = null;
    set({ playing: false, driftAt: 0 });
  }
  if (state.drift && state.playing && state.driftAt && Date.now() >= state.driftAt) step(1);
  renderClock();
}

// ---- data -------------------------------------------------------------------
// Switching stations starts at the busiest room (and plays it if you're listening).
// A refresh of the same station keeps the room you're in.
async function tuneTo(station) {
  const refresh = station === state.station && state.rooms.length > 0;
  const keep = refresh ? current() : null;
  if (!refresh) set({ station, rooms: [], index: 0, problems: [] });
  savePrefs();
  const res = await api(`/api/tune?station=${encodeURIComponent(station)}`);
  if (res.error) return set({ problems: [res.error] });
  const kept = keep ? res.data.findIndex((r) => r.id === keep.id) : -1;
  set({ rooms: res.data, index: Math.max(0, kept), problems: res.meta.problems || [],
        budget: res.meta.budget || state.budget });
  if (state.playing && !refresh && res.data.length) play(current());
}

async function keepRoom() {
  const room = current();
  if (!room || room.source === "saved") return;
  const res = await api("/api/saved", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ link: room.url, title: room.title, topic: room.topic }) });
  $("add-msg").textContent = res.error || `Kept “${room.title}”.`;
  if (!res.error) tuneTo(state.station);
}

async function addRoom(event) {
  event.preventDefault();
  const link = $("add-link").value.trim();
  const title = $("add-title").value.trim();
  const res = await api("/api/saved", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ link, title }) });
  $("add-msg").textContent = res.error || "Added. It's on every station now.";
  if (res.error) return;
  event.target.reset();
  tuneTo(state.station);
}

async function removeRoom(id) {
  const res = await api(`/api/saved/${encodeURIComponent(id)}`, { method: "DELETE" });
  $("add-msg").textContent = res.error || "Removed from your dial.";
  tuneTo(state.station);
}

// ---- drawing ----------------------------------------------------------------
function ago(iso) {
  if (!iso) return "";
  const min = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60000));
  return min < 60 ? `live ${min} min` : `live ${Math.floor(min / 60)} h ${min % 60} min`;
}

function describe(room) {
  if (room.source === "saved") return "your room · may have ended";
  const bits = [`${room.listeners} ${room.listeners === 1 ? "person" : "people"} in the room`, ago(room.started_at)];
  return bits.filter(Boolean).join(" · ");
}

function renderDial() {
  const dial = $("dial");
  dial.replaceChildren(...state.stations.map((name) => {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = name;
    b.setAttribute("aria-pressed", String(name === state.station));
    b.addEventListener("click", () => tuneTo(name));
    return b;
  }));
}

function renderNow() {
  const room = current();
  $("now-label").textContent = state.playing ? "On air" : room ? "Up next" : "Quiet";
  $("now-title").textContent = room ? room.title : emptyLine();
  $("now-meta").textContent = room ? describe(room) : "";
  $("listen").textContent = state.playing ? "Listening ✓" : "Tune in";
  $("listen").disabled = !room;
  $("next").disabled = state.rooms.length < 2;
  $("keep").disabled = !room || room.source === "saved";
  document.querySelector(".now").classList.toggle("playing", state.playing);
}

function emptyLine() {
  if (state.problems.length) return "Can't hear anything right now";
  return state.liveSearch ? "No live rooms on this station yet" : "Add a room below to start";
}

function renderQueue() {
  $("count").textContent = state.rooms.length ? `· ${state.rooms.length}` : "";
  const items = state.rooms.map((room, i) => {
    const li = document.createElement("li");
    li.className = i === state.index ? "current" : "";
    const t = Object.assign(document.createElement("span"), { className: "t", textContent: room.title });
    const n = Object.assign(document.createElement("span"), { className: "n",
      textContent: room.source === "saved" ? "saved" : `${room.listeners} listening` });
    const x = Object.assign(document.createElement("span"), { className: "x", textContent: describe(room) });
    li.append(t, n, x);
    if (room.source === "saved") {
      const rm = Object.assign(document.createElement("button"), { className: "rm", type: "button", textContent: "remove" });
      rm.addEventListener("click", (e) => { e.stopPropagation(); removeRoom(room.id); });
      x.append(" · ", rm);
    }
    li.addEventListener("click", () => { set({ index: i }); play(room); });
    return li;
  });
  if (!items.length) {
    const li = Object.assign(document.createElement("li"), { className: "empty",
      textContent: state.liveSearch ? "Nothing live matched. Try another station, or check back soon."
        : "Live search is off (no X key yet). Paste rooms you find below and they'll play here." });
    items.push(li);
  }
  $("queue").replaceChildren(...items);
  $("problems").hidden = !state.problems.length;
  $("problems").textContent = state.problems.join(" ");
}

function renderClock() {
  const left = state.driftAt - Date.now();
  $("drift-clock").textContent = state.drift && state.playing && left > 0
    ? `next in ${Math.floor(left / 60000)}:${String(Math.floor(left / 1000) % 60).padStart(2, "0")}` : "";
}

function renderFoot() {
  const b = state.budget;
  $("mode").textContent = state.liveSearch ? "live search on" : "saved rooms only";
  $("mode").classList.toggle("on", state.liveSearch);
  $("budget").textContent = state.liveSearch && b
    ? `X search today: $${b.spent.toFixed(3)} of $${b.cap.toFixed(2)} (${b.spaces_paid} rooms seen, ${b.calls} searches). Each room costs half a cent once a day; results refresh every 10 min.`
    : "No money is being spent. Add an X key to let the radio find live rooms itself (see README).";
}

function render() { renderDial(); renderNow(); renderQueue(); renderClock(); renderFoot(); }

// ---- wiring -----------------------------------------------------------------
async function start() {
  const prefs = loadPrefs();
  $("hunt").href = HUNT_URL;
  $("listen").addEventListener("click", () => play(current()));
  $("next").addEventListener("click", () => step(1));
  $("keep").addEventListener("click", keepRoom);
  $("add-form").addEventListener("submit", addRoom);
  $("drift-on").addEventListener("change", (e) =>
    set({ drift: e.target.checked, driftAt: e.target.checked && state.playing ? Date.now() + state.driftMin * 60000 : 0 }));
  $("drift-min").addEventListener("change", (e) => {
    set({ driftMin: Number(e.target.value), driftAt: state.drift && state.playing ? Date.now() + Number(e.target.value) * 60000 : 0 });
    savePrefs();
  });
  document.addEventListener("keydown", (e) => {
    if (e.target.closest("input, select, textarea")) return;
    if (e.key === "ArrowRight") step(1);
    if (e.key === "ArrowLeft") step(-1);
  });
  if (prefs.driftMin) { $("drift-min").value = String(prefs.driftMin); state = { ...state, driftMin: prefs.driftMin }; }

  const status = await api("/api/status");
  if (status.error) return set({ problems: [status.error] });
  const stations = status.data.stations;
  const station = stations.includes(prefs.station) ? prefs.station : stations[0];
  set({ stations, liveSearch: status.data.live_search, budget: status.data.budget });
  await tuneTo(station);
  setInterval(tick, 1000);
  setInterval(() => state.liveSearch && tuneTo(state.station), 10 * 60000); // cached server-side
}

start();
