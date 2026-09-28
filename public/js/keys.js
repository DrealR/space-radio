// The keyboard: ← → tune · L listen · H I hear it · C crew · R radar · O open in X · ? manual · Esc close.
// Quiet inside text fields, while any dialog is open, and with Cmd/Ctrl/Alt (those are the browser's).
// The arrows are the radio's only when the radio has them: the dial itself, or nothing focused at
// all. Anything else that can hold focus — the ORDER radiogroup, a band chip, a select, a text
// field — keeps them, so a choice in progress is never yanked to another room.

const ARROWS = new Set(["ArrowRight", "ArrowDown", "ArrowLeft", "ArrowUp"]);
const onDial = (e) => {
  const el = e.target;
  if (!el) return true;
  return el === document.body || el === document.documentElement
    || el === document.getElementById?.("knob");
};

/** act: { blocked(), tune(delta), push(), heard(), crew(), radar(), openX(), manual(), escape() } */
export function wireKeys(act) {
  const keys = {
    ArrowRight: () => act.tune(1), ArrowDown: () => act.tune(1),
    ArrowLeft: () => act.tune(-1), ArrowUp: () => act.tune(-1),
    l: act.push, h: act.heard, c: act.crew, r: act.radar, o: act.openX, "?": act.manual, Escape: act.escape,
  };
  document.addEventListener("keydown", (e) => {
    if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || (e.repeat && e.key.length === 1)) return;
    if (e.target.closest?.("input, select, textarea, [contenteditable]") || act.blocked()) return;
    if (ARROWS.has(e.key) && !onDial(e)) return;
    const run = keys[e.key.length === 1 ? e.key.toLowerCase() : e.key];
    if (!run) return;
    e.preventDefault();
    run();
  });
}
