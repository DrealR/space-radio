// Draws the launch: the big button, the ON AIR lamp, the three-lamp rail, the airlock
// panel and the radio's presence (on air, docked, hailing). Draws only; the words come
// from airCopy() and every press goes back through view.onChip().
import { isHailing } from "./airlock.js";
import { $, el, glyph, glyphNodes, replaceKeepingFocus, setGlyphText } from "./dom.js";
import { intentUrl, spaceUrl } from "./rooms.js";

const LAMP_TITLES = {
  onair: "On air: you told the radio you hear the room",
  stby: "Standing by: X is waiting for its own Start listening press",
  off: "Not in a room",
};

function renderPtt(ptt, view) {
  const a = $("ptt");
  a.setAttribute("href", (view.room && spaceUrl(view.room.id)) || "#");
  if (ptt.mode === "newtab") {
    a.target = "_blank";
    a.rel = "noopener";
  } else {
    a.removeAttribute("target");
    a.removeAttribute("rel");
  }
  a.classList.toggle("off", ptt.mode === "off");
  a.setAttribute("aria-disabled", String(ptt.mode === "off"));
  a.classList.toggle("breathe", !view.learned.push && ptt.mode !== "off");
  setGlyphText($("ptt-text"), ptt.text);
  setGlyphText($("ptt-sub"), ptt.sub);
}

function renderLamp(lamp) {
  const node = $("lamp-air");
  node.classList.toggle("on", lamp === "onair");
  node.classList.toggle("stby", lamp === "stby");
  const label = lamp === "stby" ? "STBY" : "ON AIR";
  if (node.textContent !== label) node.textContent = label;
  node.title = LAMP_TITLES[lamp];
}

function renderRail(rail) {
  $("rail").querySelectorAll(".rail-lamp").forEach((lamp, k) => { lamp.dataset.state = rail[k] || "off"; });
}

// ---- the airlock panel ------------------------------------------------------------
function chipHref(chip, roomId) {
  return chip.link === "intent" ? intentUrl(roomId) : spaceUrl(roomId);
}

function chipNode(chip, view) {
  const className = `chip${chip.primary ? " primary" : ""}${chip.link ? " out" : ""}`;
  const node = chip.link
    ? el("a", { className, href: chipHref(chip, view.air.roomId) || "#" })
    : el("button", { className, type: "button" });
  if (chip.link === "tab") {
    node.target = "_blank";
    node.rel = "noopener noreferrer";
  }
  node.dataset.chip = chip.id;
  node.append(...glyphNodes(chip.text));
  node.addEventListener("click", (e) => view.onChip(chip.id, e));
  return node;
}

function pill(text) {
  const node = el("span", { className: "x-pill" }, glyph("▶"), ` ${text}`);
  node.setAttribute("aria-hidden", "true");
  return node;
}

function why() {
  return el("details", { className: "why" },
    el("summary", { textContent: "Why two keys?" }),
    el("p", { textContent: "Browsers only let a site make sound after you press something on that site. The radio finds the ship; X opens the hatch." }));
}

function stepsList(panel, view) {
  if (!panel.steps.length) return null;
  return el("ol", { className: "airlock-steps" }, ...panel.steps.map((s) =>
    el("li", {}, el("span", {}, ...glyphNodes(s.text)), s.chip ? chipNode(s.chip, view) : null)));
}

function forceLink(view) {
  const href = intentUrl(view.air.roomId);
  return href ? el("a", { className: "force", href, textContent: "Force the X app" }) : null;
}

function panelCard(panel, view) {
  const lead = panel.pill
    ? el("p", { className: "airlock-body lead" }, pill(panel.pill), ...glyphNodes(panel.body ? ` ${panel.body}` : ""))
    : panel.body ? el("p", { className: "airlock-body" }, ...glyphNodes(panel.body)) : null;
  return el("div", { className: `airlock-card ${panel.variant}` },
    // tabIndex -1: focus can land on a card with no chips (blocked) instead of falling to <body>.
    panel.kicker ? el("p", { className: "airlock-kicker", tabIndex: -1 }, ...glyphNodes(panel.kicker)) : null,
    lead,
    stepsList(panel, view),
    panel.force ? forceLink(view) : null,
    panel.why ? why() : null,
    panel.note ? el("p", { className: "airlock-note", textContent: panel.note }) : null,
    panel.chips.length ? el("div", { className: "chips" }, ...panel.chips.map((c) => chipNode(c, view))) : null);
}

let drawnPanel = "";

function renderPanel(panel, view) {
  const box = $("airlock");
  const key = panel ? JSON.stringify([panel, view.air.roomId]) : "";
  if (key === drawnPanel) return;
  drawnPanel = key;
  // The card is closing under a pressed chip (IT STOPPED…): the big button takes the focus.
  if (!panel && box.contains(document.activeElement)) $("ptt").focus({ preventScroll: true });
  box.classList.toggle("open", Boolean(panel));
  box.toggleAttribute("inert", !panel);
  // Rebuild only when the words change. A pressed chip that changed the card (NO SOUND?,
  // REOPEN THIS ROOM…) hands focus to its twin, else to the new card's first chip or its kicker.
  if (!panel) return;
  replaceKeepingFocus($("airlock-in"), [panelCard(panel, view)], {
    key: "chip", fallback: (inner) => inner.querySelector("[data-chip]") || inner.querySelector(".airlock-kicker"),
  });
}

// ---- presence ---------------------------------------------------------------------
function renderPresence(view) {
  const { air } = view;
  const radio = $("radio");
  const docked = air.handle === "kept" && (air.phase === "airlock" || air.phase === "onair");
  const hailing = isHailing(air, Date.now());
  radio.classList.toggle("live", air.phase === "onair");
  radio.classList.toggle("hailing", hailing);
  radio.classList.toggle("in-airlock", air.phase === "airlock" && !hailing);
  // "over" means X sits on top of the page, not beside the radio: no seam then.
  radio.classList.toggle("docked-right", docked && air.side === "right");
  radio.classList.toggle("docked-left", docked && air.side === "left");
  const tag = $("dock-tag");
  const text = air.side === "right" ? "X DOCKED →" : "← X DOCKED";
  if (tag.dataset.text !== text) setGlyphText(tag, text);
  const name = view.title || "a room";
  document.title = air.phase === "onair" ? `● ON AIR · ${name} · Space Radio`
    : air.phase === "airlock" ? `▶ STBY · ${name}` : "Space Radio";
}

/** view = { air, room, learned, title, onChip(id, event) } */
export function renderLaunch(copy, view) {
  renderPtt(copy.ptt, view);
  renderLamp(copy.lamp);
  renderRail(copy.rail);
  renderPanel(copy.panel, view);
  renderPresence(view);
}
