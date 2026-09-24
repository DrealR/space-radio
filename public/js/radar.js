// The bridge scope: every ship on this band as a blip, swept by a rotating beam.
// Tapping a ship tunes the radio to it (the dial still never touches X).
import { blipLayout, byCrowd, SWEEP_SECONDS } from "./radar-model.js";
import { bandLabel } from "./rooms.js";
import { el } from "./dom.js";

const HINT = "Hover or focus a ship to read it. Tap to tune.";
let dialog = null;
let returnTo = null;

function shell(onClose) {
  const close = el("button", { type: "button", className: "radar-x", textContent: "✕" });
  close.setAttribute("aria-label", "Close radar");
  close.addEventListener("click", () => dialog.close());
  const d = el("dialog", { id: "radar", className: "radar" },
    el("div", { className: "radar-card" },
      el("header", { className: "radar-head" },
        el("p", { className: "radar-kicker", id: "radar-kicker" }),
        el("h2", { className: "radar-title", id: "radar-title" }),
        close),
      el("div", { className: "scope", id: "radar-scope" },
        el("i", { className: "scope-rings" }), el("i", { className: "scope-sweep" }),
        el("div", { className: "scope-blips", id: "radar-blips" })),
      el("p", { className: "radar-readout", id: "radar-readout", textContent: HINT }),
      el("p", { className: "radar-legend", textContent: "Nearer the centre: a bigger crowd · green halo: voices on the mic · blue: your presets" })));
  d.setAttribute("aria-labelledby", "radar-title");
  d.style.setProperty("--sweep", `${SWEEP_SECONDS}s`);
  d.addEventListener("click", (e) => { if (e.target === d) d.close(); }); // tap outside the card
  d.addEventListener("close", onClose);
  document.body.append(d);
  return d;
}

function blipButton(blip, pick) {
  const b = el("button", { type: "button", className: `blip ${blip.kind}${blip.mic ? " mic" : ""}${blip.current ? " current" : ""}` },
    el("span", { className: "blip-core" }));
  b.setAttribute("aria-label", blip.current ? `${blip.label} (tuned now)` : blip.label);
  b.style.cssText = `left:${blip.x}%;top:${blip.y}%;--s:${blip.size}px;--d:${blip.delay}s`;
  const read = () => { document.getElementById("radar-readout").textContent = blip.label; };
  b.addEventListener("pointerenter", read);
  b.addEventListener("focus", read);
  b.addEventListener("click", () => pick(blip.id));
  return b;
}

/** Opens the scope for the rooms the dial holds now. pick(id) tunes the radio. */
export function openRadar({ rooms, currentId, band }, pick) {
  if (!dialog) dialog = shell(() => { returnTo?.focus?.(); returnTo = null; });
  returnTo = document.activeElement;
  const ships = byCrowd(rooms);
  const choose = (id) => { dialog.close(); pick(id); };
  document.getElementById("radar-kicker").textContent = `BRIDGE SCOPE · ${bandLabel(band)} BAND`;
  document.getElementById("radar-title").textContent =
    ships.length ? `${ships.length} ${ships.length === 1 ? "ship" : "ships"} in range` : "No ships in range";
  document.getElementById("radar-readout").textContent = ships.length ? HINT : "Try another band, or come back tonight.";
  document.getElementById("radar-blips").replaceChildren(...blipLayout(ships, currentId).map((b) => blipButton(b, choose)));
  dialog.showModal();
  const here = dialog.querySelector(".blip.current") || dialog.querySelector(".blip") || dialog.querySelector(".radar-x");
  here.focus();
}

export const isRadarOpen = () => Boolean(dialog?.open);
