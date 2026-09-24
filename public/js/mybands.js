// Bands you make: a short name and up to two search words, kept in this browser.
// Pure: no DOM, tested in tests/mybands.test.mjs. The server accepts the same words
// (spaces_radio/words.py): 2-30 of a-z 0-9 space # $ -, so both sides spell them alike.

export const MY_PREFIX = "my:";
export const MAX_BANDS = 5;
export const MAX_WORDS = 2; // each word is its own paid search
export const NAME_MAX = 6;
const WORD = /^[a-z0-9#$\- ]{2,30}$/;
const ALNUM = /[a-z0-9]/;

export const isMine = (band) => typeof band === "string" && band.startsWith(MY_PREFIX);
export const bandKey = (b) => MY_PREFIX + b.name;
export const searchPath = (word) => `/api/search?q=${encodeURIComponent(word)}`;

export function normalizeWord(text) {
  const word = String(text ?? "").toLowerCase().split(/\s+/).filter(Boolean).join(" ");
  return WORD.test(word) && ALNUM.test(word) ? word : null;
}

function normalizeName(text) {
  const name = String(text ?? "").toUpperCase().replace(/[^A-Z0-9 ]/g, "").trim().slice(0, NAME_MAX).trim();
  return /[A-Z0-9]/.test(name) ? name : null;
}

/** Words from what someone typed ("guitar, open mic"): unique, valid, at most three. */
export function parseWords(text) {
  const parts = String(text ?? "").split(",").map((p) => p.trim()).filter(Boolean);
  const words = [...new Set(parts.map(normalizeWord).filter(Boolean))];
  return { words: words.slice(0, MAX_WORDS), rejected: parts.filter((p) => !normalizeWord(p)), extra: words.length > MAX_WORDS };
}

/** A new band from the form, or the reason it can't be one. */
export function makeBand(nameText, wordsText) {
  const { words, rejected } = parseWords(wordsText);
  if (rejected.length) return { band: null, error: `"${rejected[0].slice(0, 30)}" can't be a search word: use 2-30 letters or numbers.` };
  if (!words.length) return { band: null, error: "Add at least one search word, like guitar." };
  const name = normalizeName(nameText) || normalizeName(words[0]);
  if (!name) return { band: null, error: "Give the band a short name." };
  return { band: Object.freeze({ name, words: Object.freeze(words) }), error: null };
}

/** Returns a new list; never edits the one passed in. */
export function addBand(bands, band) {
  if (bands.some((b) => b.name === band.name)) return { bands, error: `You already have a band called ${band.name}.` };
  if (bands.length >= MAX_BANDS) return { bands, error: `Five bands is the most. Clear one first.` };
  return { bands: [...bands, band], error: null };
}

export const removeBand = (bands, name) => bands.filter((b) => b.name !== name);
export const findBand = (bands, key) => bands.find((b) => bandKey(b) === key) || null;

/** Trusts nothing from storage: rebuilds each band through makeBand. */
export function loadBands(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.reduce((kept, b) => {
    const { band } = makeBand(b?.name, Array.isArray(b?.words) ? b.words.join(",") : "");
    return band && kept.length < MAX_BANDS && !kept.some((k) => k.name === band.name) ? [...kept, band] : kept;
  }, []);
}

/** Rooms from each word, each room once (the first word to find it keeps it). */
export function mergeRooms(lists) {
  const seen = new Set();
  return lists.flat().filter((r) => r && !seen.has(r.id) && seen.add(r.id));
}
