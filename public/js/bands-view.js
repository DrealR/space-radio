// The piano-key bands: the radio's own, then yours, then ＋ to make one. The keys are built
// once per list of bands; a render only moves the pressed key, so focus stays on the key you pressed.
import { bandLabel } from "./rooms.js";
import { $, el, replaceKeepingFocus } from "./dom.js";

function bandKey(name, title, onTune, extra = "") {
  const key = el("button", { type: "button", textContent: bandLabel(name), title, className: extra });
  key.dataset.key = name;
  key.addEventListener("click", () => onTune(name));
  return key;
}

function addKey(onAdd) {
  const key = el("button", { type: "button", className: "add", textContent: "＋" });
  key.dataset.key = "+add";
  key.setAttribute("aria-label", "Make your own band");
  key.title = "Make your own band";
  key.addEventListener("click", onAdd);
  return key;
}

/** mine: [{ key, words }] for bands you made; onAdd opens the band maker. */
export function renderBands(bands, band, onTune, { mine = [], onAdd } = {}) {
  const box = $("bands");
  const sig = [...bands, ...mine.map((m) => `${m.key}=${m.words.join(",")}`)].join("|");
  if (box.dataset.sig !== sig) {
    box.dataset.sig = sig;
    replaceKeepingFocus(box, [
      ...bands.map((name) => bandKey(name, `Band: ${name}`, onTune)),
      ...mine.map((m) => bandKey(m.key, `Your band: ${m.words.join(", ")}`, onTune, "mine")),
      ...(onAdd ? [addKey(onAdd)] : []),
    ]);
  }
  box.querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.key === band)));
}
