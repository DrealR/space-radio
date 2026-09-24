// The piano-key bands. The keys are built once per list of bands; a render only moves the
// pressed key, so the key you just pressed keeps keyboard focus.
import { bandLabel } from "./rooms.js";
import { $, el, replaceKeepingFocus } from "./dom.js";

function bandKey(name, onTune) {
  const key = el("button", { type: "button", textContent: bandLabel(name), title: `Band: ${name}` });
  key.dataset.key = name;
  key.addEventListener("click", () => onTune(name));
  return key;
}

export function renderBands(bands, band, onTune) {
  const box = $("bands");
  const sig = bands.join("|");
  if (box.dataset.sig !== sig) {
    box.dataset.sig = sig;
    replaceKeepingFocus(box, bands.map((name) => bandKey(name, onTune)));
  }
  box.querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.key === band)));
}
