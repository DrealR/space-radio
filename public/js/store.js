// Browser storage that never throws. Private windows, blocked site data and previews can
// all refuse storage; the radio then just forgets, it never breaks.

function area(kind) {
  try {
    return kind === "session" ? globalThis.sessionStorage : globalThis.localStorage;
  } catch {
    return null;
  }
}

export function readRaw(key, kind = "local") {
  try {
    return area(kind)?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

export function writeRaw(key, value, kind = "local") {
  try {
    area(kind)?.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

export function removeRaw(key, kind = "local") {
  try {
    area(kind)?.removeItem(key);
  } catch {
    /* nothing stored, nothing to clear */
  }
}

export function readJson(key, fallback, kind = "local") {
  try {
    return JSON.parse(readRaw(key, kind)) ?? fallback;
  } catch {
    return fallback;
  }
}

export const writeJson = (key, value, kind = "local") => writeRaw(key, JSON.stringify(value), kind);
