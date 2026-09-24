// The keyboard: ← → tune · L listen · H I hear it · C crew · R radar · O open in X · ? manual · Esc close.
// Quiet inside text fields, while any dialog is open, and with Cmd/Ctrl/Alt (those are the browser's).

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
    const run = keys[e.key.length === 1 ? e.key.toLowerCase() : e.key];
    if (!run) return;
    e.preventDefault();
    run();
  });
}
