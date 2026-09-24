// Preset buttons and the "program a preset" form. Presets live in this browser only.
// Every function takes `app`: { state, set, current, select, flash }.
import { MAX_PRESETS, addPreset, parseSpaceId, removePreset } from "./rooms.js";
import { $, el, replaceKeepingFocus } from "./dom.js";
import { writeJson } from "./store.js";

export const PRESETS_KEY = "spaces-radio:presets";

function store(app, presets) {
  writeJson(PRESETS_KEY, presets);
  app.set({ presets });
}

function keep(app) {
  const room = app.current();
  if (!room) return;
  const { presets, error } = addPreset(app.state.presets, room.id, room.title);
  if (error) return app.flash(error.toUpperCase());
  store(app, presets);
  app.flash(`SAVED TO P${presets.length}`);
}

/** The form's submit: a pasted Space link becomes the next preset. */
export function programPreset(app, event) {
  event.preventDefault();
  const msg = $("add-msg");
  const id = parseSpaceId($("add-link").value);
  if (!id) {
    msg.textContent = "That isn't a Space link (x.com/i/spaces/…).";
    return;
  }
  const { presets, error } = addPreset(app.state.presets, id, $("add-title").value.trim());
  msg.textContent = error || `Programmed to P${presets.length}.`;
  if (error) return;
  event.target.reset();
  store(app, presets);
}

function slot(app, p, k, room) {
  const b = el("button", { type: "button", className: p ? "" : "empty" },
    `P${k + 1}`, el("small", { textContent: p ? p.title || "room" : "empty" }));
  b.dataset.key = `p${k}`;
  if (!p) {
    b.disabled = true;
    return b;
  }
  b.classList.toggle("at", room?.id === p.id);
  b.title = `Tune to P${k + 1}: ${p.title || p.id}`;
  b.addEventListener("click", () => app.select(p.id));
  return b;
}

export function renderPresets(app, room) {
  const presets = app.state.presets;
  const slots = Array.from({ length: MAX_PRESETS }, (_, k) => slot(app, presets[k], k, room));
  const keepBtn = el("button", { type: "button", className: "keep", title: "Save this room to a preset" },
    "KEEP ♥", el("small", { textContent: "save this room" }));
  keepBtn.disabled = !room || presets.some((p) => p.id === room.id);
  keepBtn.dataset.key = "keep";
  keepBtn.addEventListener("click", () => keep(app));
  // Rebuilt every render; the pressed button's twin takes its keyboard focus. After KEEP (now
  // disabled: the room is saved), focus lands on the slot it was saved to.
  replaceKeepingFocus($("presets"), [...slots, keepBtn], { fallback: (box) => box.querySelector("button.at") });

  replaceKeepingFocus($("preset-list"), presets.map((p, k) => {
    const rm = el("button", { type: "button", textContent: "clear", title: `Clear P${k + 1}` });
    rm.dataset.key = p.id;
    rm.addEventListener("click", () => store(app, removePreset(app.state.presets, p.id)));
    return el("li", {}, el("span", { textContent: `P${k + 1} · ${p.title || p.id}` }), rm);
  }), { fallback: (box) => box.querySelector("button") });
}
