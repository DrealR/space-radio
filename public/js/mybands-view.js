// The "make a band" card, opened from the ＋ key. Builds its own DOM; owns no state:
// it reads the list it's given and hands changes back through save(bands).
import { MAX_BANDS, MAX_WORDS, NAME_MAX, addBand, makeBand, removeBand } from "./mybands.js";
import { el } from "./dom.js";

let dialog = null;
let ctx = { bands: [], save: () => {}, tune: () => {} };

function field(label, input) {
  return el("label", { className: "bm-field" }, el("span", { textContent: label }), input);
}

function shell() {
  const name = el("input", { id: "bm-name", maxLength: NAME_MAX, placeholder: "GUITAR", autocomplete: "off" });
  const words = el("input", { id: "bm-words", placeholder: "guitar, acoustic, open mic", autocomplete: "off" });
  const msg = el("p", { id: "bm-msg", className: "bm-msg" });
  msg.setAttribute("role", "status");
  const form = el("form", { className: "bm-form" },
    field(`Name (up to ${NAME_MAX} letters)`, name),
    field(`Search words (up to ${MAX_WORDS}, commas between)`, words),
    el("button", { type: "submit", className: "bm-save", textContent: "Add band" }));
  form.addEventListener("submit", onSubmit);
  const close = el("button", { type: "button", className: "bm-close", textContent: "Done" });
  close.addEventListener("click", () => dialog.close());
  const d = el("dialog", { id: "bandmaker", className: "bandmaker" },
    el("div", { className: "bm-card" },
      el("p", { className: "bm-kicker", textContent: "New band" }),
      el("h2", { id: "bm-title", textContent: "Make a band" }),
      el("p", { className: "bm-lede", textContent: "The radio finds live rooms whose titles use your words. Each word is its own search (up to 5¢ when nobody searched it in the last hour), so pick words people put in titles: guitar, Detroit, bible study." }),
      form, msg,
      el("ul", { id: "bm-list", className: "bm-list" }),
      close));
  d.setAttribute("aria-labelledby", "bm-title");
  d.addEventListener("click", (e) => { if (e.target === d) d.close(); });
  document.body.append(d);
  return d;
}

function say(text) { document.getElementById("bm-msg").textContent = text; }

function onSubmit(e) {
  e.preventDefault();
  const made = makeBand(document.getElementById("bm-name").value, document.getElementById("bm-words").value);
  if (made.error) return say(made.error);
  const added = addBand(ctx.bands, made.band);
  if (added.error) return say(added.error);
  ctx = { ...ctx, bands: added.bands };
  ctx.save(added.bands);
  e.target.reset();
  dialog.close();
  ctx.tune(made.band);
}

function drawList() {
  const items = ctx.bands.map((b) => {
    const rm = el("button", { type: "button", textContent: "clear" });
    rm.setAttribute("aria-label", `Clear band ${b.name}`);
    rm.addEventListener("click", () => {
      const bands = removeBand(ctx.bands, b.name);
      ctx = { ...ctx, bands };
      ctx.save(bands);
      drawList();
      say(`Cleared ${b.name}.`);
    });
    return el("li", {}, el("span", { textContent: `${b.name} · ${b.words.join(", ")}` }), rm);
  });
  document.getElementById("bm-list").replaceChildren(...items);
  document.querySelector(".bm-form").hidden = ctx.bands.length >= MAX_BANDS;
  if (ctx.bands.length >= MAX_BANDS) say("Five bands is the most. Clear one to add another.");
}

/** bands: current list; save(bands) stores it; tune(band) switches to a new band. */
export function openBandMaker(bands, { save, tune }) {
  if (!dialog) dialog = shell();
  ctx = { bands, save, tune };
  say("");
  drawList();
  dialog.showModal();
  document.getElementById(ctx.bands.length >= MAX_BANDS ? "bm-list" : "bm-words").focus?.();
}
