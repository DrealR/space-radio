// What this listener has already learned, so the tips can step back. If storage fails,
// the tips simply show again.
import { readRaw, writeRaw } from "./store.js";

export const LEARNED_KEY = "spaces-radio:learned";
export const LEARNED_NONE = Object.freeze({ push: false, confirms: 0, preflight: false, crew: false });

/** Validated flags from stored JSON; anything odd falls back to "not learned yet". */
export function readLearned(raw) {
  let v;
  try {
    v = JSON.parse(raw);
  } catch {
    return LEARNED_NONE;
  }
  if (!v || typeof v !== "object") return LEARNED_NONE;
  const confirms = Number.isInteger(v.confirms) ? Math.min(Math.max(v.confirms, 0), 999) : 0;
  return Object.freeze({ push: v.push === true, confirms, preflight: v.preflight === true, crew: v.crew === true });
}

export const loadLearned = () => readLearned(readRaw(LEARNED_KEY));

/** Returns the new flags (a new object) after saving them. */
export function learn(learned, patch) {
  const next = readLearned(JSON.stringify({ ...learned, ...patch }));
  writeRaw(LEARNED_KEY, JSON.stringify(next));
  return next;
}
