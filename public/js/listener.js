// How the radio reaches the X window it opened, decided without touching the DOM.
//
// X's pages send Cross-Origin-Opener-Policy: same-origin-allow-popups. Browsers may
// cut the link between this page and an X window it opens: the window keeps playing,
// but to us it looks "closed" right away and can't be steered. We can't know which
// until we try, so we watch: closed within ISOLATION_MS means X cut us off ("no");
// still reachable after that means we can steer it ("yes").

export const ISOLATION_MS = 3000;

/**
 * What to do when the dial lands on a room while you're listening, or you push the button.
 *   "steer"     point the open X window at the new room (no new tab)
 *   "open"      open an X window (needs a tap or key press)
 *   "open-link" phone: the button's own link opens the X app
 *   "pending"   wait for a push, so two rooms never play at once
 */
export function planJoin({ phone, steer, windowAlive, gesture }) {
  if (phone) return gesture ? "open-link" : "pending";
  if (steer === "yes" && windowAlive) return "steer";
  return gesture ? "open" : "pending";
}

/** Read the X window each second: learn whether we can steer, and whether you closed it. */
export function readWindow({ steer, openedAt, now, alive }) {
  const young = now - openedAt < ISOLATION_MS;
  if (alive) return { steer: steer === "unknown" && !young ? "yes" : steer, userClosed: false };
  if (young && steer !== "yes") return { steer: "no", userClosed: false };
  return { steer, userClosed: steer === "yes" };
}
