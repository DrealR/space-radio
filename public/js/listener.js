// How a push reaches X, decided without touching the DOM. Tested in tests/listener.test.mjs.
//
// X's pages send Cross-Origin-Opener-Policy: same-origin-allow-popups. A browser may cut
// the link between this page and the X window it opened: X keeps playing, but to us the
// window looks "closed" and can't be steered or focused. We can't know which until we
// look, so we watch. A window that X's page has taken over (committed) and is still
// reachable after ISOLATION_MS is ours ("kept"); a kept window that goes away closed.
// A window that goes away before we ever kept it was cut off by X, however slowly X
// loaded: a slow page must not read as a closed one.
//
// The dial, the band keys, SCAN and refresh never call planPush. Only a press does.

export const ISOLATION_MS = 3000;

const WATCHED = new Set(["airlock", "onair"]);
const STEERABLE = new Set(["airlock", "onair", "lost"]);

/**
 * What one press of PUSH does.
 *   "link"    phone: the button's own same-tab link hands the room to the X app
 *   "newtab"  pop-ups are blocked: the button is a plain target=_blank link
 *   "focus"   this room's X window is open and ours: bring it forward, never reload
 *   "remind"  this room is open in an X tab we can't reach: say so, don't open a second
 *   "steer"   our X window has another room: point it at this one
 *   "open"    open a docked X window for this room
 */
export function planPush({ kind, phase, sameRoom, alive, blocked }) {
  if (kind === "phone") return "link";
  if (blocked) return "newtab";
  if (sameRoom && WATCHED.has(phase)) return alive ? "focus" : "remind";
  if (!sameRoom && STEERABLE.has(phase) && alive) return "steer";
  return "open";
}

/**
 * Read the X window once a second. Returns "kept", "cut", "closed" or null (nothing new).
 * committed: X's page has replaced the blank one every pop-up starts with.
 */
export function readWindow({ handle, openedAt, now, alive, committed = true }) {
  const young = now - openedAt < ISOLATION_MS;
  if (alive) return handle === "unknown" && !young && committed ? "kept" : null;
  if (handle === "unknown") return "cut";
  return handle === "kept" ? "closed" : null;
}
