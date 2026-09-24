// Where X's window goes, and what kind of device we're on. Pure; tested in tests/dock.test.mjs.

export const DOCK = Object.freeze({ width: 440, maxHeight: 780, gap: 16 });

const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), Math.max(lo, hi));

/**
 * Popup features that dock X beside the radio: right if it fits on this screen, else
 * left, else over the page at the screen's right edge.
 *   metrics: screenX/Y, outerWidth/Height, innerWidth/Height, availLeft/Top/Width/Height
 *   rect:    the radio's getBoundingClientRect() (left, right, top)
 */
export function dockFeatures(metrics, rect, opts = DOCK) {
  const m = { availLeft: 0, availTop: 0, ...metrics };
  const { width: W, maxHeight, gap } = { ...DOCK, ...opts };
  const chromeX = Math.max(0, (m.outerWidth - m.innerWidth) / 2);
  const chromeY = Math.max(0, m.outerHeight - m.innerHeight - chromeX);
  const radioLeft = m.screenX + chromeX + rect.left;
  const radioRight = m.screenX + chromeX + rect.right;
  const radioTop = m.screenY + chromeY + Math.max(0, rect.top);
  const screenRight = m.availLeft + m.availWidth;
  const H = Math.min(maxHeight, m.availHeight - 40);

  let side = "right";
  let L = radioRight + gap;
  if (L + W > screenRight) {
    side = "left";
    L = radioLeft - gap - W;
    if (L < m.availLeft) { side = "over"; L = screenRight - W; }
  }
  const T = clamp(radioTop, m.availTop, m.availTop + m.availHeight - H);
  const [w, h, l, t] = [W, H, L, T].map(Math.round);
  return { features: `popup=yes,width=${w},height=${h},left=${l},top=${t}`, side };
}

/** "phone" takes the same-tab link flow (the X app catches it); everything else docks. */
export function deviceKind({ coarse, hoverNone, shortSide }) {
  return coarse && hoverNone && shortSide < 768 ? "phone" : "desktop";
}

/** A tablet takes the desktop flow, but its popups open as tabs, never beside the radio. */
export const dockable = ({ coarse, hoverNone }) => !(coarse && hoverNone);

export function isStandalone(matchMedia, nav) {
  try {
    return Boolean(matchMedia("(display-mode: standalone)").matches || nav?.standalone === true);
  } catch {
    return false;
  }
}

const IN_APP = /Instagram|FBAN|FBAV|Line\/|Snapchat|TikTok|musical_ly|LinkedInApp/;
export const inAppBrowser = (ua) => IN_APP.test(String(ua || ""));
export const isAndroid = (ua) => /Android/i.test(String(ua || ""));
