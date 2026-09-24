// Pure helpers: no DOM, no network. Tested in tests/rooms.test.mjs.

export const GRILLE_DOTS = 96;
export const MAX_PRESETS = 7;
const FM_LOW = 88.1;
const FM_HIGH = 107.9;

const BAND_LABELS = { anything: "ANY", "late night": "LATE" };
export const bandLabel = (name) => BAND_LABELS[name] || name.toUpperCase().slice(0, 6);

const SORTS = {
  busy: (a, b) => b.listeners - a.listeners,
  fresh: (a, b) => (Date.parse(b.started_at) || 0) - (Date.parse(a.started_at) || 0),
  // Small rooms first, but a host talking alone goes last.
  cozy: (a, b) => cozyRank(a) - cozyRank(b),
};
const cozyRank = (r) => (r.listeners < 3 ? 1000 + r.listeners : r.listeners);

export function sortRooms(rooms, mode) {
  return [...rooms].sort(SORTS[mode] || SORTS.busy);
}

/** Live rooms in order, then presets that aren't already live on this band. */
export function buildDeck(live, sort, presets) {
  const sorted = sortRooms(live, sort);
  const liveIds = new Set(sorted.map((r) => r.id));
  const mine = presets.filter((p) => !liveIds.has(p.id)).map(presetRoom);
  return [...sorted, ...mine];
}

export function presetRoom(p) {
  return { id: p.id, title: p.title || "Preset room", listeners: null, speakers: 0, hosts: 0,
           started_at: "", lang: "", source: "yours", url: `https://x.com/i/spaces/${p.id}` };
}

/** Spread the deck across the FM band so "next" always sweeps the needle right. */
export function position(index, count) {
  return count <= 1 ? 50 : 4 + (92 * index) / (count - 1);
}

export function frequency(index, count) {
  const pct = count <= 1 ? 0.5 : index / (count - 1);
  const raw = FM_LOW + pct * (FM_HIGH - FM_LOW);
  const odd = Math.round((raw - FM_LOW) / 0.2) * 0.2 + FM_LOW; // FM stations sit on odd tenths
  return odd.toFixed(1);
}

export function ago(iso, now = Date.now()) {
  const t = Date.parse(iso);
  if (!t) return "";
  const min = Math.max(0, Math.round((now - t) / 60000));
  if (min < 1) return "JUST STARTED";
  return min < 60 ? `LIVE ${min}M` : `LIVE ${Math.floor(min / 60)}H${String(min % 60).padStart(2, "0")}`;
}

export function signalBars(listeners) {
  if (listeners == null) return 0;
  return [1, 5, 20, 60, 200].filter((t) => listeners >= t).length;
}

export function hash(text) {
  let h = 2166136261;
  for (const ch of text) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return h >>> 0;
}

function seeded(seed) {
  let a = seed || 1;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Which grille dots light up, and how: hosts amber, people on the mic green,
 * listeners warm white. Scattered by the room's id so each room has its own crowd.
 */
export function grillePlan(room, dots = GRILLE_DOTS) {
  const empty = { cells: Array(dots).fill(""), perDot: 1, known: false };
  if (!room || room.listeners == null) return empty;
  const total = Math.max(room.listeners, room.hosts + room.speakers);
  const perDot = Math.max(1, Math.ceil(total / dots));
  const hosts = Math.min(room.hosts, dots);
  const mics = Math.min(room.speakers, dots - hosts);
  const lit = Math.min(dots, Math.max(hosts + mics, Math.ceil(total / perDot)));
  const kinds = [...Array(hosts).fill("host"), ...Array(mics).fill("mic"),
                 ...Array(lit - hosts - mics).fill("ear")];
  const order = [...Array(dots).keys()];
  const rand = seeded(hash(room.id));
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  const cells = Array(dots).fill("");
  kinds.forEach((kind, k) => { cells[order[k]] = kind; });
  return { cells, perDot, known: true };
}

const ID = /^[A-Za-z0-9]{8,20}$/;
const URL_ID = /(?:x|twitter)\.com\/i\/spaces\/([A-Za-z0-9]{8,20})/;

export function parseSpaceId(text) {
  const t = String(text || "").trim();
  const m = t.match(URL_ID);
  if (m) return m[1];
  return ID.test(t) ? t : null;
}

/** Returns a new preset list; never edits the one passed in. */
export function addPreset(presets, id, title) {
  if (presets.some((p) => p.id === id)) return { presets, error: "Already on a preset." };
  if (presets.length >= MAX_PRESETS) return { presets, error: "Presets are full. Clear one first." };
  return { presets: [...presets, { id, title: String(title || "").slice(0, 80) }], error: null };
}

export const removePreset = (presets, id) => presets.filter((p) => p.id !== id);

// X tags each Space with a language. "other" (undetermined) is common for short English
// titles like "Chill", so English-only keeps en, other and unknown and drops the rest.
const ENGLISH_ISH = new Set(["en", "other", "", "und"]);

export function onlyEnglish(rooms, on) {
  return on ? rooms.filter((r) => ENGLISH_ISH.has((r.lang || "").toLowerCase())) : rooms;
}

/** What the screen shows for a language: nothing when X couldn't tell. */
export function langLabel(lang) {
  const code = (lang || "").toLowerCase();
  return code === "en" || !ENGLISH_ISH.has(code) ? code.toUpperCase() : "";
}
