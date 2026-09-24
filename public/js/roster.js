// What a crew scan teaches the radio about a room: exact headcounts and the host's handle.
// Pure; tested in tests/roster.test.mjs. The scan itself lives in crew.js.

export const ROSTER_TTL_MS = 600000; // same as crew.js's memo: older names aren't shown
const HANDLE = /^[A-Za-z0-9_]{1,15}$/;

const count = (v) => (Number.isInteger(v) && v >= 0 ? v : 0);

/** The small, validated part of a CrewData we keep. */
export function rosterFrom(data, now = Date.now()) {
  const username = data?.host?.username;
  return Object.freeze({
    hosts: count(data?.counts?.hosts),
    speakers: count(data?.counts?.speakers),
    listeners: count(data?.listeners),
    host: typeof username === "string" && HANDLE.test(username) ? username : "",
    at: Number.isFinite(data?.at) ? data.at : now,
  });
}

export function freshRoster(rosters, id, now = Date.now()) {
  const r = rosters?.[id];
  return r && now - r.at < ROSTER_TTL_MS ? r : null;
}

/** The deck room with the scan's headcount laid over it. Never edits the room. */
export function withRoster(room, rosters, now = Date.now()) {
  const r = room && freshRoster(rosters, room.id, now);
  return r ? { ...room, hosts: r.hosts, speakers: r.speakers, listeners: r.listeners } : room;
}

/** Rosters plus one; a new object every time. */
export const addRoster = (rosters, id, data, now = Date.now()) => ({ ...rosters, [id]: rosterFrom(data, now) });
