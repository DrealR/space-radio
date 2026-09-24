// The tune knob (drag, click, scroll, Enter or Space) and swipes on the screen and glass.
// Tuning only ever lines up a room; it never touches X. Tested in tests/knob.test.mjs.
const DRAG_STEP_PX = 34;
const SWIPE_PX = 40;

export function onSwipe(node, handler) {
  let start = null;
  node.addEventListener("pointerdown", (e) => { start = { x: e.clientX, y: e.clientY }; });
  node.addEventListener("pointerup", (e) => {
    if (!start) return;
    const dx = e.clientX - start.x;
    const dy = e.clientY - start.y;
    start = null;
    if (Math.abs(dx) > SWIPE_PX && Math.abs(dx) > Math.abs(dy)) handler(dx < 0 ? 1 : -1);
  });
}

/**
 * step(delta) tunes; detent() is the optional click you feel per step while dragging.
 * "Tap = next room" has one path, the click event, so mouse, touch, Enter, Space and screen
 * readers all tune exactly once. A drag already tuned as it turned, so its click is skipped.
 */
export function wireKnob(knob, step, detent) {
  let drag = null;
  let dragged = false;
  knob.addEventListener("pointerdown", (e) => {
    drag = { x: e.clientX, y: e.clientY, moved: 0 };
    dragged = false;
    try { knob.setPointerCapture(e.pointerId); } catch { /* the drag still works without capture */ }
  });
  knob.addEventListener("pointermove", (e) => {
    if (!drag) return;
    const travel = (e.clientX - drag.x) - (e.clientY - drag.y);
    const steps = Math.trunc(travel / DRAG_STEP_PX);
    if (steps === drag.moved) return;
    step(steps - drag.moved);
    detent();
    drag = { ...drag, moved: steps };
  });
  knob.addEventListener("pointerup", () => {
    dragged = Boolean(drag && drag.moved !== 0);
    drag = null;
  });
  knob.addEventListener("pointercancel", () => { drag = null; dragged = false; });
  knob.addEventListener("click", (e) => {
    const skip = dragged && e.detail !== 0; // a keyboard click (detail 0) always tunes
    dragged = false;
    if (!skip) step(1);
  });
  knob.addEventListener("wheel", (e) => { e.preventDefault(); step(e.deltaY > 0 ? 1 : -1); }, { passive: false });
}
