// The two-key launch as a pure state machine. Key 1 is PUSH on the radio; key 2 is
// X's own ▶ Start listening, pressed once per room. No DOM, no clock: callers pass
// `now`, and every event returns a new frozen object.
//
// Only a person's press may produce `heard` (I HEAR IT, I'M IN, STILL HEAR IT, or H).
// Nothing else can put the radio ON AIR, because only the listener knows X is playing.

export const HAIL_MS = 1200;    // the push animation, before the airlock settles
export const ASK_MS = 4000;     // come back sooner than this and we don't ask yet
export const QUIET_MS = 20000;  // still waiting after this: show the "no sound?" hint
export const AWAY_GRACE_MS = 2500; // a phone hand-off that never hid the page (chooser dismissed…)

// X's words. If X renames its button, change them here and nowhere else.
export const X_START = "Start listening";
export const X_START_ANON = "Start listening anonymously";

export const PHASES = Object.freeze(["idle", "airlock", "onair", "blocked", "lost", "away", "back"]);
export const HANDLES = Object.freeze(["unknown", "kept", "cut", "none"]);
export const SIDES = Object.freeze(["right", "left", "over", "tab", "app"]);

// `note` rides along with an opened room: "steered" (the X window was pointed at a new
// room) or "stale" (an older X window may still be playing). Copy only; no logic reads it.
// `inTab` (phone): X played in this very tab, so coming back here stopped the sound.
export const AIR_IDLE = Object.freeze({
  phase: "idle", roomId: null, since: 0, handle: "none", side: "right",
  asked: false, quietShown: false, help: false, wasOnAir: false, note: "", inTab: false,
});

const FRESH = { asked: false, quietShown: false, help: false, wasOnAir: false, note: "", inTab: false };
const HEARABLE = new Set(["airlock", "lost", "back"]);
const WATCHED = new Set(["airlock", "onair"]);
const OPEN = new Set(["airlock", "onair", "lost"]);

/** Can the listener say "I hear it" now? Never after X played in this tab and we came back. */
export const canHear = (air) => HEARABLE.has(air.phase) && !(air.phase === "back" && air.inTab);

const pick = (value, allowed, fallback) => (allowed.includes(value) ? value : fallback);

function opened(air, e) {
  return {
    ...air, ...FRESH, phase: "airlock", roomId: e.roomId, since: e.now,
    side: pick(e.side, SIDES, "tab"), handle: pick(e.handle, HANDLES, "unknown"),
    note: e.note === "steered" || e.note === "stale" ? e.note : "",
  };
}

function returned(air, e) {
  if (air.phase === "away") return { ...air, phase: "back", since: e.now, inTab: Boolean(e.inTab) };
  // pageshow can land after visibilitychange: the later, surer answer wins.
  if (air.phase === "back" && e.inTab && !air.inTab) return { ...air, inTab: true };
  if (air.phase === "airlock" && !air.asked && e.now - air.since >= ASK_MS) return { ...air, asked: true };
  return air;
}

// Blocked keeps what it knew: a room already open in X is still playing there.
function blocked(air, e) {
  return {
    ...AIR_IDLE, phase: "blocked", roomId: e.roomId, since: e.now, side: "tab",
    wasOnAir: air.phase === "onair" || (air.phase === "lost" && air.wasOnAir),
    note: (OPEN.has(air.phase) && air.roomId !== e.roomId) || (air.phase === "blocked" && air.note === "stale")
      ? "stale" : "",
  };
}

function quiet(air, e) {
  return air.phase === "airlock" && e.now - air.since >= QUIET_MS ? { ...air, quietShown: true } : air;
}

function windowClosed(air) {
  if (!WATCHED.has(air.phase)) return air;
  return { ...air, phase: "lost", handle: "none", wasOnAir: air.phase === "onair" };
}

const EVENTS = {
  opened,
  blocked,
  heard: (air, e) => (canHear(air)
    ? { ...air, phase: "onair", help: false, asked: false, since: e.now, note: "" } : air),
  noSound: (air) => (air.phase === "idle" ? air : { ...air, help: true }),
  dismiss: (air) => ({ ...air, help: false }),
  returned,
  quiet,
  handleKept: (air) => (air.handle === "unknown" ? { ...air, handle: "kept" } : air),
  handleCut: (air) => (air.handle === "unknown" || air.handle === "kept" ? { ...air, handle: "cut" } : air),
  windowClosed,
  stopped: () => AIR_IDLE,
  away: (air, e) => ({ ...AIR_IDLE, phase: "away", roomId: e.roomId, since: e.now, side: "app" }),
  reset: () => AIR_IDLE,
};

export const AIR_EVENTS = Object.freeze(Object.keys(EVENTS));

/** The next air state. Never edits `air`; unknown events return an equal copy. */
export function airNext(air, event) {
  const step = event && Object.hasOwn(EVENTS, event.type) ? EVENTS[event.type] : (a) => a;
  return Object.freeze({ ...step(air, event || {}) });
}

// Derived, never stored.
const LINEABLE = new Set(["airlock", "onair", "lost", "back", "away"]);

export const isHailing = (air, now) => air.phase === "airlock" && now - air.since < HAIL_MS;
export const isHere = (air, currentId) => Boolean(currentId) && air.roomId === currentId;

/** The needle sits on a different room than the one X has (or is opening). */
export const isLinedUp = (air, currentId) => LINEABLE.has(air.phase) && !isHere(air, currentId);
