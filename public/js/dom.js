// Small DOM helpers. Text always goes in with textContent, never innerHTML.

export const $ = (id) => document.getElementById(id);

export function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children.filter((c) => c != null && c !== ""));
  return node;
}

// The web fonts carry no arrows, play or check marks, and some phones draw ▶ and ↗ as
// emoji. These few glyphs are drawn from the SVG sprite in index.html instead.
const GLYPHS = { "▶": "g-play", "↗": "g-out", "→": "g-right", "←": "g-left", "↓": "g-down", "✓": "g-check",
                 "✗": "g-cross", "▸": "g-tri" };
const GLYPH_RE = /([▶↗→←↓✓✗▸])/u;
const SVG_NS = "http://www.w3.org/2000/svg";

export function glyph(char) {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("class", "g");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  const use = document.createElementNS(SVG_NS, "use");
  use.setAttribute("href", `#${GLYPHS[char]}`);
  svg.append(use);
  return svg;
}

/** Text as nodes, with the special glyphs swapped for SVG. */
export function glyphNodes(text) {
  return String(text).split(GLYPH_RE).filter(Boolean)
    .map((part) => (GLYPHS[part] ? glyph(part) : document.createTextNode(part)));
}

/** Set a node's text with glyphs; skips the work when nothing changed. */
export function setGlyphText(node, text) {
  if (!node || node.dataset.text === text) return;
  node.dataset.text = text;
  node.replaceChildren(...glyphNodes(text));
}

/**
 * Replace a box's children without dropping keyboard focus. If focus was inside, it moves to
 * the new control with the same data-<key> (a rebuilt band key, preset or chip), else to
 * fallback(box) when given. Without this, every render sends a keyboard user back to <body>.
 */
export function replaceKeepingFocus(box, nodes, { key = "key", fallback = null, doc = globalThis.document } = {}) {
  const active = doc?.activeElement;
  const inside = Boolean(active && active !== box && box.contains(active));
  const had = inside ? active.dataset?.[key] : undefined;
  box.replaceChildren(...nodes);
  if (!inside) return;
  const same = had === undefined ? null
    : [...box.querySelectorAll(`[data-${key}]`)].find((n) => n.dataset[key] === had && !n.disabled);
  (same || fallback?.(box))?.focus?.({ preventScroll: true });
}

/** Restart a one-shot CSS effect. State never waits for it to end. */
const effects = new WeakMap();
export function pulse(node, cls, ms) {
  if (!node) return;
  const timers = effects.get(node) || {};
  clearTimeout(timers[cls]);
  node.classList.remove(cls);
  void node.offsetWidth; // let the animation start over
  node.classList.add(cls);
  effects.set(node, { ...timers, [cls]: setTimeout(() => node.classList.remove(cls), ms) });
}
