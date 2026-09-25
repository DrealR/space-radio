// The fuel gauge: today's estimated X spend, what spent it, and what's free.
// Reads /api/fuel (never cached, never touches X). Pure helpers are tested in tests/fuel.test.mjs.
import { $, el } from "./dom.js";

const REFRESH_MS = 90 * 1000;
const LOW = 0.8;

// What costs fuel, in the words the radio uses. Prices: X bills ½¢ per room and 1¢ per person.
export const COSTS = Object.freeze([
  ["Opening a band nobody opened in the last hour", "up to 10¢", "2 searches, up to 10 rooms each"],
  ["Your own band, per word", "up to 5¢", "each word is its own search"],
  ["WHO'S HERE (names in a room)", "about 10–15¢", "1¢ per person named, ½¢ for the room"],
  ["The same band again within the hour", "free", "everyone shares one answer"],
]);
export const FREE = "Flipping rooms, the knob, ◎ RADAR, sorting, SCAN, PUSH, I HEAR IT, OPEN IN X, BEAM, DOCK and its tones, presets.";

export const money = (dollars) => (dollars < 1 ? `${Math.round(dollars * 100)}¢` : `$${dollars.toFixed(2)}`);

/** How full the day's tank is. */
export function fuelLevel(data) {
  if (!data || !(data.cap > 0)) return { ratio: 0, level: "unknown", words: "FUEL" };
  const ratio = Math.min(1, data.spent / data.cap);
  const level = ratio >= 1 ? "empty" : ratio >= LOW ? "low" : "ok";
  return { ratio, level, words: `${money(data.spent)} / ${money(data.cap)}` };
}

/** The first warning this refresh should show, if any: each level warns once a day. */
export function fuelWarning(level, warned) {
  if (level === "empty" && !warned.empty) return { key: "empty", text: "OUT OF FUEL TODAY · SAVED ROOMS STILL PLAY" };
  if (level === "low" && !warned.low) return { key: "low", text: "FUEL LOW · TAP ⛽ TO SEE WHAT'S SPENDING" };
  return null;
}

function row(r) {
  const pct = r.cap > 0 ? Math.min(100, Math.round((r.spent / r.cap) * 100)) : 0;
  const bar = el("span", { className: "fc-bar" }, el("i"));
  bar.firstChild.style.width = `${pct}%`;
  return el("li", { className: "fc-row" },
    el("span", { className: "fc-label", textContent: r.label }),
    el("span", { className: "fc-amt", textContent: `${money(r.spent)} of ${money(r.cap)}` }),
    bar,
    el("small", { textContent: `${r.items} ${r.unit} · ${r.calls} ${r.calls === 1 ? "call" : "calls"}` }));
}

export function createFuel(app) {
  let data = null;
  let warned = {};
  let card = null;

  function draw() {
    const gauge = $("fuel");
    if (!gauge) return;
    const { ratio, level, words } = fuelLevel(data);
    gauge.dataset.level = level;
    $("fuel-fill").style.width = `${Math.round(ratio * 100)}%`;
    $("fuel-text").textContent = data ? words : "FUEL";
    gauge.setAttribute("aria-label", data ? `X fuel today: ${words}. Open the fuel log.` : "X fuel: open the fuel log");
    if (card?.open) fillCard();
  }

  async function refresh() {
    try {
      const res = await fetch("/api/fuel", { cache: "no-store" });
      const body = await res.json();
      if (!body.success) return;
      data = body.data;
      if (data.day !== warned.day) warned = { day: data.day };
      const warn = fuelWarning(fuelLevel(data).level, warned);
      if (warn) { warned = { ...warned, [warn.key]: true }; app.flash(warn.text, 4500); }
      draw();
    } catch { /* the gauge just keeps its last reading */ }
  }

  function fillCard() {
    const { words } = fuelLevel(data);
    document.getElementById("fc-total").textContent = data ? words : "No reading yet";
    document.getElementById("fc-rows").replaceChildren(...(data?.rows || []).map(row));
    document.getElementById("fc-note").textContent = data?.shared === false
      ? "This radio keeps its own ledger here. Your real balance lives at console.x.com, under Credits."
      : "An estimate from the radio's own shared ledger; it resets at midnight UTC. Your real balance lives at console.x.com, under Credits.";
  }

  function open() {
    if (!card) {
      const close = el("button", { type: "button", className: "fc-close", textContent: "Done" });
      close.addEventListener("click", () => card.close());
      card = el("dialog", { id: "fuelcard", className: "fuelcard" },
        el("div", { className: "fc-card" },
          el("p", { className: "fc-kicker", textContent: "X fuel · today" }),
          el("h2", { id: "fc-total", className: "fc-total" }),
          el("ul", { id: "fc-rows", className: "fc-rows" }),
          el("h3", { textContent: "What costs fuel" }),
          el("ul", { className: "fc-costs" }, ...COSTS.map(([what, price, why]) =>
            el("li", {}, el("b", { textContent: price }), el("span", { textContent: what }), el("small", { textContent: why })))),
          el("h3", { textContent: "Free, always" }),
          el("p", { className: "fc-free", textContent: FREE }),
          el("p", { className: "fc-tip", textContent: "Cheapest way to see who's in a room: OPEN IN X shows everyone, free." }),
          el("p", { id: "fc-note", className: "fc-note" }),
          close));
      card.setAttribute("aria-labelledby", "fc-total");
      card.addEventListener("click", (e) => { if (e.target === card) card.close(); });
      document.body.append(card);
    }
    fillCard();
    card.showModal();
    refresh();
  }

  setInterval(() => { if (!document.hidden) refresh(); }, REFRESH_MS);
  return { refresh, open, draw };
}
