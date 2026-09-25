// The ship's log: every ship you boarded, when, for how long, on which band. Pure: no DOM,
// no storage, no clock (callers pass `now`). Tested in tests/flightlog.test.mjs.
// The log lives only in this browser (flightlog-view.js saves it); nothing here reaches a server.
import { cleanTitle } from "./beam.js";

export const LOG_KEY = "spaces-radio:flight-log";
export const MAX_FLIGHTS = 40;
export const CONTINUE_MS = 10 * 60000; // back on the same ship within ten minutes: the same flight
export const MAX_FLIGHT_MS = 12 * 3600000; // a page closed while aboard never logs a week-long flight

const ID = /^[A-Za-z0-9]{8,20}$/;
const HANDLE = /^[A-Za-z0-9_]{1,15}$/;
const USER_ID = /^[0-9]{1,20}$/;
const MAX_HOST_IDS = 10;
// Aboard, as far as the radio knows. "lost" holds the flight open but stops its clock:
// the radio can't tell whether X is still playing.
const HELD = new Set(["airlock", "onair", "lost", "away", "back"]);
const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];

const handleOf = (v) => (typeof v === "string" && HANDLE.test(v) ? v : "");
const hostIdsOf = (raw) => (Array.isArray(raw)
  ? [...new Set(raw.filter((v) => typeof v === "string" && USER_ID.test(v)))].slice(0, MAX_HOST_IDS) : []);
const peopleOf = (v) => (Number.isInteger(v) && v >= 0 ? v : null);
const bandOf = (v) => cleanTitle(v).slice(0, 40);

function flight(f) {
  const host = handleOf(f.host);
  return Object.freeze({
    id: f.id,
    title: cleanTitle(f.title) || "Untitled room",
    band: bandOf(f.band),
    host,
    hostId: host && typeof f.hostId === "string" && USER_ID.test(f.hostId) ? f.hostId : "",
    hostIds: Object.freeze(hostIdsOf(f.hostIds)),
    start: f.start,
    last: Math.min(Math.max(f.last, f.start), f.start + MAX_FLIGHT_MS),
    heard: f.heard === true,
    people: peopleOf(f.people),
  });
}

export const flightKey = (f) => `${f.id}@${f.start}`;
export const flightTime = (f) => Math.max(0, f.last - f.start);
export const totalAboard = (log) => log.reduce((sum, f) => sum + flightTime(f), 0);

/** Flights from storage, rebuilt one by one: junk, bad times and duplicates are dropped. */
export function readLog(raw) {
  if (!Array.isArray(raw)) return Object.freeze([]);
  const seen = new Set();
  const kept = raw.filter((f) => f && typeof f === "object" && typeof f.id === "string" && ID.test(f.id)
      && Number.isFinite(f.start) && Number.isFinite(f.last) && f.last >= f.start)
    .map(flight)
    .filter((f) => !seen.has(flightKey(f)) && seen.add(flightKey(f)));
  return Object.freeze(kept.slice(0, MAX_FLIGHTS));
}

/** When this observation puts the flight's clock: running while docked, the trip's own times on a phone. */
function clockAt(air, now) {
  if (air.phase === "airlock" || air.phase === "onair") return now;
  if (air.phase === "away" || air.phase === "back") return air.since;
  return null; // lost: the clock waits
}

const same = (a, b) => Object.keys(a).every((k) => (k === "hostIds" ? a[k].join() === b[k].join() : a[k] === b[k]));

/**
 * The log after one look at the radio. obs: { air, room, band, host, hostId, wasAboard, now }.
 * `room` is the ship the airlock names; `host`/`hostId` come from a crew scan, if one was made;
 * `wasAboard` is whether the last look already had this ship aboard. Returns the same log when
 * nothing changed, so the caller can skip saving.
 */
export function logFlight(log, { air, room, band, host = "", hostId = "", wasAboard = false, now }) {
  if (!HELD.has(air?.phase) || !ID.test(String(air.roomId ?? ""))) return log;
  const at = clockAt(air, now);
  const head = log[0];
  const ref = air.phase === "away" ? air.since : now;
  if (head && head.id === air.roomId && (wasAboard || ref - head.last <= CONTINUE_MS)) {
    const named = !head.host && handleOf(host);
    const next = flight({
      ...head,
      last: at == null ? head.last : Math.max(head.last, at),
      heard: head.heard || air.phase === "onair",
      host: named ? host : head.host,
      hostId: named ? hostId : head.hostId,
      hostIds: head.hostIds.length ? head.hostIds : hostIdsOf(room?.host_ids),
      people: Math.max(head.people ?? -1, peopleOf(room?.listeners) ?? -1),
    });
    return same(next, head) ? log : Object.freeze([next, ...log.slice(1)]);
  }
  const start = at ?? now;
  const fresh = flight({
    id: air.roomId, title: room?.title, band, host, hostId, hostIds: room?.host_ids,
    start, last: start, heard: air.phase === "onair", people: room?.listeners,
  });
  return Object.freeze([fresh, ...log].slice(0, MAX_FLIGHTS));
}

/** A new log without one flight; never edits the one passed in. */
export const removeFlight = (log, key) => Object.freeze(log.filter((f) => flightKey(f) !== key));

/** "<1M", "42M", "2H05": the radio's own way of writing time. */
export function duration(ms) {
  const min = Math.floor(ms / 60000);
  if (min < 1) return "<1M";
  return min < 60 ? `${min}M` : `${Math.floor(min / 60)}H${String(min % 60).padStart(2, "0")}`;
}

/** "SEP 25 · 21:04" in the listener's own time zone. */
export function stamp(ms) {
  const d = new Date(ms);
  const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  return `${MONTHS[d.getMonth()]} ${d.getDate()} · ${hm}`;
}
