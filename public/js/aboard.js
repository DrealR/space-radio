// Who's aboard. The crew manifest lives in crew.js, built on its own and loaded only when
// someone asks for it. Names cost this radio money, so nothing here scans by itself: the
// speaker, the C key or the manifest's own buttons do. If crew.js can't load, the radio
// keeps working and points at X's own page, which shows everyone for free.
import { airNext } from "./airlock.js";
import { spaceUrl } from "./rooms.js";
import { addRoster } from "./roster.js";
import { $ } from "./dom.js";
import { holo } from "./sfx.js";

// The loaded module, cached like any import. The only state this file keeps.
let crewModule = null;
let pending = null;

function load() {
  pending = pending || import("./crew.js")
    .then((m) => {
      if (typeof m.openCrew !== "function") throw new Error("crew.js has no openCrew()");
      crewModule = m;
      return m;
    })
    .catch((err) => {
      pending = null; // let the next press try again
      throw err;
    });
  return pending;
}

export function isCrewShowing() {
  try {
    return Boolean(crewModule?.isCrewOpen());
  } catch {
    return false;
  }
}

/** Close the manifest if it's showing (a phone coming back from X must see the radio's question). */
export function closeCrewIfOpen(crewApi = crewModule) {
  try {
    if (crewApi?.isCrewOpen()) crewApi.closeCrew();
  } catch (err) {
    console.warn("[spaces-radio] couldn't close the crew manifest", err);
  }
}

/** Fetch crew.js while the radio is idle, so the first press opens at once. */
export function preloadCrew() {
  const go = () => load().catch((err) => console.warn("[spaces-radio] crew scanner not preloaded", err));
  if ("requestIdleCallback" in window) window.requestIdleCallback(go, { timeout: 5000 });
  else setTimeout(go, 1500);
}

function offline(app, err) {
  console.warn("[spaces-radio] crew scanner offline", err);
  app.flash("CREW SCANNER OFFLINE · OPEN IN X ↗");
  $("open-x")?.focus();
}

/** X says the room is over: remember it, and stand down if it was the one on air. */
function ended(app, id) {
  if (app.state.ended.includes(id)) return;
  const air = app.state.air;
  const stop = air.roomId === id && (air.phase === "airlock" || air.phase === "onair");
  app.set({ ended: [...app.state.ended, id], air: stop ? airNext(air, { type: "stopped" }) : air });
}

/**
 * The contract's opts for openCrew(room, opts). launch: the radio's bound push and leaveForX;
 * crewApi: the loaded crew module. Every button acts on `room`, the one the manifest names.
 */
export function crewOptions(app, launch, room, crewApi = crewModule) {
  const copy = app.copy();
  const phone = app.device.kind === "phone";
  return {
    label: app.channelLabel(),
    status: copy.here && app.state.air.phase === "onair" ? "onair" : copy.linedUp ? "lined" : null,
    phone,
    anchor: $("radio"),
    returnFocus: $("speaker"),
    listen: {
      text: copy.ptt.text, sub: copy.ptt.sub, href: spaceUrl(room.id),
      disabled: copy.ptt.mode === "off",
      onClick: (e) => {
        const moved = app.current()?.id !== room.id && app.deck().some((r) => r.id === room.id);
        if (moved) app.select(room.id, { quiet: true }); // the needle moved under the open manifest
        launch.push(e);
      },
    },
    // A phone leaves for X in this tab: close the sheet first, so it isn't covering the radio on return.
    onOpenX: () => {
      if (!phone) return;
      launch.leaveForX(room);
      closeCrewIfOpen(crewApi);
    },
    onRoster: (id, data) => app.set({ rosters: addRoster(app.state.rosters, id, data) }),
    onEnded: (id) => ended(app, id),
    onNext: () => app.step(1),
    onClose: () => app.render(),
    sound: (name) => { if (app.sfxOk()) holo(name); },
  };
}

/** The speaker and the C key: open the manifest for the room under the needle. */
export async function showCrew(app, launch) {
  if (!app.current()) return;
  if (!app.state.learned.crew) app.learn({ crew: true });
  let crew;
  try {
    crew = await load();
  } catch (err) {
    return offline(app, err);
  }
  const room = app.current(); // read after the load: the needle may have moved meanwhile
  if (!room) return;
  try {
    crew.openCrew(room, crewOptions(app, launch, room, crew));
  } catch (err) {
    offline(app, err);
  }
}
