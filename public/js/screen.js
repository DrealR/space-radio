// The VFD screen, the dial glass and the speaker grille. Draws what it's given; owns no state.
import { GRILLE_DOTS, ago, bandLabel, frequency, grillePlan, langLabel, position, signalBars } from "./rooms.js";
import { $, el, replaceKeepingFocus, setGlyphText } from "./dom.js";

const GRILLE_COLS = 12;
const DOTS = /\s*···$/;
let booting = false;

const channel = (i, n) => `CH ${String(i + 1).padStart(2, "0")}/${String(n).padStart(2, "0")}`;

function screenText(room, s, host) {
  if (s.loading) return { title: "SCANNING THE BAND…", info: "" };
  if (!room && !s.liveSearch) return { title: "NO SIGNAL · PROGRAM A PRESET ↓", info: "AUTO-TUNE IS OFF" };
  if (!room && s.english && s.live.length) return { title: "ONLY OTHER LANGUAGES HERE", info: "FLIP EN OFF TO HEAR THEM" };
  if (!room) return { title: "DEAD AIR ON THIS BAND", info: "TRY ANOTHER BAND" };
  const lead = host ? `HOST @${host}` : "";
  if (room.beamed && room.listeners == null) {
    return { title: room.title, info: [lead, "BEAMED IN · PUSH TO JOIN"].filter(Boolean).join(" · ") };
  }
  if (room.source === "yours" && room.listeners == null) {
    const slot = s.presets.findIndex((p) => p.id === room.id) + 1;
    return { title: room.title, info: [lead, `PRESET P${slot} · MAY HAVE ENDED`].filter(Boolean).join(" · ") };
  }
  const bits = [lead, `${room.listeners} IN ROOM`, room.speakers ? `${room.speakers} ON MIC` : "",
                ago(room.started_at), langLabel(room.lang)];
  return { title: room.title, info: bits.filter(Boolean).join(" · ") };
}

function drawTitle(title) {
  const titleEl = $("lcd-title");
  if (booting || titleEl.dataset.title === title) return;
  titleEl.dataset.title = title;
  titleEl.textContent = title;
  const box = titleEl.parentElement;
  box.classList.remove("scroll");
  requestAnimationFrame(() => {
    if (titleEl.scrollWidth <= box.clientWidth) return;
    titleEl.textContent = `${title}   ✦   ${title}   ✦   `;
    box.style.setProperty("--dur", `${Math.max(8, title.length * 0.32)}s`);
    box.classList.add("scroll");
  });
}

/** One LCD line; a trailing "···" becomes three dots that step while hailing. */
function drawInfo(text) {
  const node = $("lcd-info");
  if (node.dataset.text === text) return;
  if (!DOTS.test(text)) return setGlyphText(node, text);
  setGlyphText(node, text.replace(DOTS, ""));
  node.dataset.text = text;
  node.append(" ", el("span", { className: "dots" }, el("i", { textContent: "·" }),
    el("i", { textContent: "·" }), el("i", { textContent: "·" })));
}

/** state: the app state; lcd: the launch's status line (or null); host: "@handle" once scanned. */
export function renderScreen({ room, d, i, state, lcd, host }) {
  const { title, info } = screenText(room, state, host);
  $("lcd-ch").textContent = d.length ? channel(i, d.length) : "CH --";
  $("lcd-freq").textContent = d.length ? `${frequency(i, d.length)} FM` : "--.- FM";
  $("lcd-band").textContent = bandLabel(state.band);
  drawTitle(title);
  drawInfo(state.flash || lcd || (state.problems.length && !room ? "SIGNAL TROUBLE" : info));
  const bars = signalBars(room?.listeners);
  [...$("lcd-signal").children].forEach((bar, k) => bar.classList.toggle("on", k < bars));
}

export function renderGlass(d, i, { onSelect, playing, ended }) {
  const max = Math.max(1, ...d.map((r) => r.listeners || 0));
  replaceKeepingFocus($("markers"), d.map((room, k) => {
    const size = room.listeners == null ? 0.4 : 0.18 + 0.82 * Math.log1p(room.listeners) / Math.log1p(max);
    const people = room.listeners == null ? "headcount unknown" : `${room.listeners} people`;
    const label = `Channel ${k + 1} · ${people} · ${room.title}`;
    const mark = el("button", { type: "button", title: label, className: room.source === "yours" ? "mine" : "" });
    mark.dataset.key = room.id;
    mark.setAttribute("aria-label", label);
    mark.style.left = `${position(k, d.length)}%`;
    mark.style.height = `${Math.round(size * 100)}%`;
    mark.classList.toggle("at", k === i);
    mark.classList.toggle("playing", room.id === playing);
    mark.classList.toggle("ended", ended.includes(room.id));
    mark.addEventListener("click", (e) => { e.stopPropagation(); onSelect(room.id); });
    return mark;
  }));
  $("glass").classList.toggle("empty", !d.length);
  // The markers box is inset 12px each side; line the needle up with it.
  $("needle").style.left = d.length ? `calc(12px + (100% - 24px) * ${position(i, d.length) / 100})` : "";
}

function grilleDots() {
  const rows = GRILLE_DOTS / GRILLE_COLS;
  return Array.from({ length: GRILLE_DOTS }, (_, k) => {
    const dot = el("i");
    // The signal-lock ripple leaves the centre first: delay by distance, 18 ms a dot.
    const dist = Math.hypot((k % GRILLE_COLS) - (GRILLE_COLS - 1) / 2, Math.floor(k / GRILLE_COLS) - (rows - 1) / 2);
    dot.style.setProperty("--rd", `${Math.round(dist * 18)}ms`);
    dot.style.setProperty("--td", `${(k * 137) % 1600}ms`); // talking out of step, like people
    return dot;
  });
}

export function renderGrille(room) {
  const plan = grillePlan(room);
  const grille = $("grille");
  if (grille.children.length !== GRILLE_DOTS) grille.replaceChildren(...grilleDots());
  [...grille.children].forEach((dot, k) => { dot.className = plan.cells[k]; });
  $("grille-key").textContent = !room ? "" : !plan.known ? "NO HEADCOUNT FOR PRESETS"
    : plan.perDot === 1 ? "1 DOT = 1 PERSON" : `1 DOT ≈ ${plan.perDot} PEOPLE`;
}

/** Once per session: the title types a systems check while the band loads. Never blocks. */
export function bootType(text, done) {
  const node = $("lcd-title");
  booting = true;
  let k = 0;
  const timer = setInterval(() => {
    k += 1;
    node.textContent = text.slice(0, k);
    if (k < text.length) return;
    clearInterval(timer);
    setTimeout(() => {
      booting = false;
      node.dataset.title = "";
      done();
    }, 420);
  }, 18);
}
