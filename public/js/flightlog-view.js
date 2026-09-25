// The ship's log card (the LOG key next to ◎ RADAR): ships you boarded, and the hosts you starred.
// Owns the log (in memory and in this browser's storage); stars live in app state because the dial
// orders by them. Reaches the radio only through the app door. The models are pure:
// flightlog.js and favorites.js.
import { LOG_KEY, MAX_FLIGHTS, duration, flightKey, flightTime, logFlight, readLog, removeFlight, stamp, totalAboard } from "./flightlog.js";
import { FAVS_KEY, favFrom, favLabel, freshFavRooms, nameFavs, removeFav, toggleFav } from "./favorites.js";
import { freshRoster } from "./roster.js";
import { bandLabel, spaceUrl } from "./rooms.js";
import { el, glyphNodes, replaceKeepingFocus } from "./dom.js";
import { readJson, removeRaw, writeJson } from "./store.js";

const HEARTBEAT_MS = 15000; // how often an open flight's clock is written down
const HELD = new Set(["airlock", "onair", "lost", "away", "back"]);
const CLEAR_ARM_MS = 4000;

export const PRIVACY = `Kept only in this browser, never sent anywhere. The last ${MAX_FLIGHTS} flights. `
  + "A private window forgets them when it closes.";
export const FAV_NOTE = "When a starred host's ship is live on the band you're on, it comes first on the dial. "
  + "The radio matches the room list it already has, so stars cost no X fuel.";

export function createFlightLog(app) {
  let log = readLog(readJson(LOG_KEY, []));
  let aboardId = null;
  let savedAt = 0;
  let saved = log;
  const announced = new Set();
  let card = null;
  let clearArmed = 0;

  function save(now = Date.now()) {
    if (saved === log) return;
    if (!writeJson(LOG_KEY, log)) app.flash("LOG NOT SAVED · THIS BROWSER REFUSES STORAGE", 3200);
    saved = log;
    savedAt = now;
  }

  function saveFavs(favs) {
    writeJson(FAVS_KEY, favs);
    app.set({ favs });
  }

  const roomOf = (id) => app.deck().find((r) => r.id === id) || { id, title: app.state.airTitle };

  /** One look at the radio. Called after every render and on a heartbeat; cheap when nothing changed. */
  function observe(now = Date.now()) {
    const { air, band, rosters, favs } = app.state;
    const roster = air.roomId ? freshRoster(rosters, air.roomId, now) : null;
    const before = log;
    log = logFlight(log, { air, room: air.roomId ? roomOf(air.roomId) : null, band, host: roster?.host || "",
                           hostId: roster?.hostId || "", wasAboard: aboardId === air.roomId, now });
    aboardId = HELD.has(air.phase) ? air.roomId : null;
    if (log !== before) {
      const [was, is] = [before[0], log[0]];
      const news = log.length !== before.length || !was || flightKey(was) !== flightKey(is)
        || was.heard !== is.heard || was.host !== is.host;
      if (news || now - savedAt >= HEARTBEAT_MS) save(now);
      if (card?.open) fill();
      const named = nameFavs(favs, log);
      if (named !== favs) queueMicrotask(() => saveFavs(named));
    }
    announceFavs();
  }

  function announceFavs() {
    const fresh = freshFavRooms(app.deck(), announced);
    if (!fresh.length) return;
    fresh.forEach((r) => announced.add(r.id));
    const ch = app.deck().findIndex((r) => r.id === fresh[0].id) + 1;
    queueMicrotask(() => {
      app.flash(`★ STARRED HOST LIVE · CH ${String(ch).padStart(2, "0")}`, 4000);
      app.say(`A host you starred is live: ${fresh[0].title}, channel ${ch}.`);
    });
  }

  // ---- actions ------------------------------------------------------------------------------
  function retune(f) {
    card.close();
    if (!app.deck().some((r) => r.id === f.id)) {
      // Not on this band's dial: it rides at the end, like a beamed room. Switching bands could spend fuel.
      app.set({ beam: { id: f.id, title: f.title, from: "log" } });
      app.select(f.id);
      app.flash("FROM YOUR LOG · MAY HAVE ENDED · PUSH TO TRY", 4000);
      return;
    }
    app.select(f.id);
    app.flash("FROM YOUR LOG · PUSH TO BOARD", 3000);
  }

  function star(f) {
    const pick = favFrom(f);
    if (!pick) return;
    const { favs, on, error } = toggleFav(app.state.favs, pick);
    if (error) return say(error);
    saveFavs(favs);
    say(on ? `Starred ${favLabel(pick)}.` : `Unstarred ${favLabel(pick)}.`);
    fill();
  }

  function forget(f) {
    log = removeFlight(log, flightKey(f));
    save();
    say("Flight struck from the log.");
    fill();
  }

  function clearAll(button) {
    const now = Date.now();
    if (now - clearArmed > CLEAR_ARM_MS) {
      clearArmed = now;
      button.textContent = "Press again to clear";
      return;
    }
    clearArmed = 0;
    log = Object.freeze([]);
    aboardId = null;
    removeRaw(LOG_KEY);
    saved = log;
    say("Log cleared. Stars stay until you unstar them.");
    fill();
  }

  // ---- drawing ------------------------------------------------------------------------------
  function say(text) { document.getElementById("fl-msg").textContent = text; }

  function button(text, cls, onClick, label, key) {
    const b = el("button", { type: "button", className: cls }, ...glyphNodes(text));
    if (key) b.dataset.key = key;
    if (label) b.setAttribute("aria-label", label);
    b.addEventListener("click", onClick);
    return b;
  }

  function entry(f, favIds) {
    const pick = favFrom(f);
    const k = flightKey(f);
    const starredNow = Boolean(pick && favIds.has(pick.id));
    const url = spaceUrl(f.id);
    const who = f.host ? `host @${f.host}` : pick ? "host not named" : "host unknown";
    const crowd = f.people == null ? "" : ` · ${f.people} aboard`;
    const open = el("a", { className: "fl-btn", href: url, target: "_blank", rel: "noopener noreferrer" }, ...glyphNodes("OPEN IN X ↗"));
    open.setAttribute("aria-label", `Open ${f.title} in X (free)`);
    open.dataset.key = `${k}:x`;
    const starBtn = button(starredNow ? "★ STARRED" : "☆ STAR HOST", `fl-btn star${starredNow ? " on" : ""}`, () => star(f),
      starredNow ? `Unstar ${favLabel(pick)}` : `Star ${pick ? favLabel(pick) : "the host"}`, `${k}:star`);
    starBtn.disabled = !pick;
    if (!pick) starBtn.title = "The radio never learned who hosted this room";
    const mark = el("span", { className: "fl-stamp" }, ...glyphNodes(f.heard ? "HEARD ✓" : "BOARDED"));
    mark.setAttribute("aria-label", f.heard ? "You heard it" : "Boarded, not confirmed");
    return el("li", { className: `fl-entry${f.heard ? " heard" : ""}` },
      el("div", { className: "fl-meta" },
        el("span", { className: "fl-when", textContent: stamp(f.start) }),
        el("span", { className: "fl-band", textContent: f.band ? bandLabel(f.band) : "--" }),
        el("span", { className: "fl-dur", textContent: duration(flightTime(f)) })),
      el("p", { className: "fl-title", textContent: f.title }),
      el("p", { className: "fl-sub", textContent: who + crowd }),
      mark,
      el("div", { className: "fl-btns" },
        button("RE-TUNE", "fl-btn tune", () => retune(f), `Re-tune to ${f.title}`, `${k}:tune`),
        open, starBtn,
        button("✕", "fl-btn strike", () => forget(f), `Strike ${f.title} from the log`, `${k}:strike`)));
  }

  function favItem(f) {
    return el("li", {}, el("span", { textContent: `★ ${favLabel(f)}` }),
      button("unstar", "fl-unstar", () => { saveFavs(removeFav(app.state.favs, f.id)); say(`Unstarred ${favLabel(f)}.`); fill(); },
        `Unstar ${favLabel(f)}`, `fav:${f.id}`));
  }

  function fill() {
    const favs = app.state.favs;
    const favIds = new Set(favs.map((f) => f.id));
    const n = log.length;
    document.getElementById("fl-title").textContent = n
      ? `${n} ${n === 1 ? "flight" : "flights"} · ${duration(totalAboard(log))} aboard` : "No flights yet";
    // Rebuilt on every change (the heartbeat moves the clock); focus stays on the same control.
    const toDone = () => card.querySelector(".fl-done");
    replaceKeepingFocus(document.getElementById("fl-list"), log.map((f) => entry(f, favIds)), { fallback: toDone });
    document.getElementById("fl-empty").hidden = n > 0;
    replaceKeepingFocus(document.getElementById("fl-favs"), favs.map(favItem), { fallback: toDone });
    document.getElementById("fl-nofavs").hidden = favs.length > 0;
    const clear = document.getElementById("fl-clear");
    clear.disabled = n === 0;
    if (Date.now() - clearArmed > CLEAR_ARM_MS) clear.textContent = "Clear log";
  }

  function shell() {
    const done = el("button", { type: "button", className: "fl-done", textContent: "Done" });
    done.addEventListener("click", () => card.close());
    const clear = el("button", { type: "button", id: "fl-clear", className: "fl-clear", textContent: "Clear log" });
    clear.addEventListener("click", () => clearAll(clear));
    const msg = el("p", { id: "fl-msg", className: "fl-msg" });
    msg.setAttribute("role", "status");
    const d = el("dialog", { id: "flightlog", className: "flightlog" },
      el("div", { className: "fl-card" },
        el("p", { className: "fl-kicker", textContent: "Ship's log · SR-26" }),
        el("h2", { id: "fl-title", className: "fl-title-h" }),
        el("p", { className: "fl-privacy", textContent: PRIVACY }),
        msg,
        el("ol", { id: "fl-list", className: "fl-list" }),
        el("p", { id: "fl-empty", className: "fl-empty", textContent: "Push to board a ship and it lands here: when, how long, which band." }),
        el("h3", { textContent: "★ Favorite hosts" }),
        el("p", { className: "fl-note", textContent: FAV_NOTE }),
        el("ul", { id: "fl-favs", className: "fl-favs" }),
        el("p", { id: "fl-nofavs", className: "fl-note", textContent: "No stars yet. Tap ☆ STAR HOST on a flight." }),
        el("div", { className: "fl-actions" }, clear, done)));
    d.setAttribute("aria-labelledby", "fl-title");
    d.addEventListener("click", (e) => { if (e.target === d) d.close(); });
    document.body.append(d);
    return d;
  }

  function open() {
    if (!card) card = shell();
    observe();
    save();
    say("");
    fill();
    card.showModal();
    card.querySelector(".fl-btn.tune, .fl-done")?.focus();
  }

  setInterval(() => observe(), HEARTBEAT_MS);
  window.addEventListener("pagehide", () => { observe(); save(); });
  document.addEventListener("visibilitychange", () => { if (document.hidden) { observe(); save(); } });
  return Object.freeze({ observe, open });
}
