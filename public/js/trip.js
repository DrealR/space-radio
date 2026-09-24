// A phone trip to X and back. Leaving for the X app may unload this page, so the room
// you left for rides in sessionStorage and the radio asks "did it play?" when you return.
import { readRaw, removeRaw, writeRaw } from "./store.js";

export const TRIP_KEY = "spaces-radio:trip";
export const TRIP_MAX_MS = 30 * 60000;
const ID = /^[A-Za-z0-9]{8,20}$/;

/** A valid trip from stored JSON, or null for junk, a bad id, or one older than 30 minutes. */
export function readTrip(raw, now) {
  let trip;
  try {
    trip = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!trip || typeof trip !== "object" || Array.isArray(trip)) return null;
  const { roomId, band, title, at } = trip;
  if (typeof roomId !== "string" || !ID.test(roomId)) return null;
  if (!Number.isFinite(at) || now - at < 0 || now - at >= TRIP_MAX_MS) return null;
  return Object.freeze({
    roomId,
    band: typeof band === "string" ? band.slice(0, 40) : "",
    title: typeof title === "string" ? title.slice(0, 200) : "",
    at,
  });
}

export function saveTrip({ roomId, band, title, at }) {
  return writeRaw(TRIP_KEY, JSON.stringify({ roomId, band, title, at }), "session");
}

export const loadTrip = (now) => readTrip(readRaw(TRIP_KEY, "session"), now);
export const clearTrip = () => removeRaw(TRIP_KEY, "session");

/**
 * What coming back to the radio means on a phone. Memory wins: a page that stayed alive
 * knows it was away, however long you listened. Storage only speaks after a cold reload.
 *   "back"     away (or back, and now we learn X played in this very tab): ask how it went
 *   "restore"  idle with a recent trip stored: the page reloaded while you were in X
 *   null       nothing to do
 */
export function returnPlan(air, trip, inTab = false) {
  if (air.phase === "away") return "back";
  if (air.phase === "back") return inTab && !air.inTab ? "back" : null;
  return air.phase === "idle" && trip ? "restore" : null;
}
