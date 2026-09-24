// The one mutable thing in the radio. A browser window object is a live handle into
// another page: it can't be copied into immutable state, and it changes under us (X can
// cut it, you can close it). So this module owns it, and state only records what we
// learned about it (air.handle).

const NAME = "sr-x";
let win = null;
let openedAt = 0;

/** Must run synchronously inside a click or key press, or the browser blocks it. */
export function openX(url, features = "") {
  try {
    win = window.open(url, NAME, features) || null;
  } catch (err) {
    console.warn("[spaces-radio] couldn't open X", err);
    win = null;
  }
  if (win) openedAt = Date.now();
  return Boolean(win);
}

export function aliveX() {
  try {
    return Boolean(win && !win.closed);
  } catch {
    return false;
  }
}

/** Point the open X window at another room. False if X cut us off. */
export function steerX(url) {
  if (!aliveX()) return false;
  try {
    win.location.href = url;
    return true;
  } catch (err) {
    console.warn("[spaces-radio] couldn't steer X", err);
    return false;
  }
}

export function focusX() {
  if (!aliveX()) return false;
  try {
    win.focus();
    return true;
  } catch {
    return false;
  }
}

/** Has X's page replaced the blank page a pop-up starts with? That blank page is ours and
 *  its address reads fine; reading a cross-origin page's address throws. */
export function committedX() {
  if (!aliveX()) return false;
  try {
    return !win.location.href;
  } catch {
    return true;
  }
}

export const holdingX = () => win !== null;
export const openedAtX = () => openedAt;
export function dropX() {
  win = null;
}
