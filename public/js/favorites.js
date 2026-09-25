// Favorite hosts: star a host from your ship's log; when one of their ships is live on the band
// you're on, it comes first on the dial. Matching uses the host ids X already sent with the band's
// rooms, so a star never costs an X call. Pure; tested in tests/favorites.test.mjs.
import { cleanTitle } from "./beam.js";

export const FAVS_KEY = "spaces-radio:favorite-hosts";
export const MAX_FAVS = 24;

const HANDLE = /^[A-Za-z0-9_]{1,15}$/;
const USER_ID = /^[0-9]{1,20}$/;

const fav = (id, handle, note) => Object.freeze({
  id, handle: typeof handle === "string" && HANDLE.test(handle) ? handle : "", note: cleanTitle(note),
});

/**
 * The star a logged flight can give: the host a crew scan named (id and handle together),
 * else the first host X listed for the room, remembered by the room's title. Null when the
 * radio never learned who hosted (a preset or a beamed room).
 */
export function favFrom(f) {
  if (f?.hostId && USER_ID.test(f.hostId)) return fav(f.hostId, f.host, f.title);
  const id = Array.isArray(f?.hostIds) ? f.hostIds.find((v) => typeof v === "string" && USER_ID.test(v)) : null;
  return id ? fav(id, "", f.title) : null;
}

export const favLabel = (f) => (f.handle ? `@${f.handle}` : `the host of “${f.note || "a room"}”`);

/** Stars from storage, rebuilt; bad ids and repeats are dropped. */
export function readFavs(raw) {
  if (!Array.isArray(raw)) return Object.freeze([]);
  const seen = new Set();
  const kept = raw.filter((f) => f && typeof f.id === "string" && USER_ID.test(f.id) && !seen.has(f.id) && seen.add(f.id))
    .map((f) => fav(f.id, f.handle, typeof f.note === "string" ? f.note : ""));
  return Object.freeze(kept.slice(0, MAX_FAVS));
}

/** Star or unstar. Returns { favs, on, error }; never edits the list passed in. */
export function toggleFav(favs, f) {
  if (favs.some((x) => x.id === f.id)) return { favs: removeFav(favs, f.id), on: false, error: null };
  if (favs.length >= MAX_FAVS) return { favs, on: false, error: `${MAX_FAVS} stars is the most. Unstar one first.` };
  return { favs: Object.freeze([...favs, fav(f.id, f.handle, f.note)]), on: true, error: null };
}

export const removeFav = (favs, id) => Object.freeze(favs.filter((f) => f.id !== id));

/** Stars that only had an id pick up the handle a later crew scan found. Same list when nothing's new. */
export function nameFavs(favs, flights) {
  const names = new Map(flights.filter((f) => f?.hostId && f.host).map((f) => [f.hostId, f.host]));
  if (!favs.some((f) => !f.handle && names.has(f.id))) return favs;
  return Object.freeze(favs.map((f) => (!f.handle && names.has(f.id) ? fav(f.id, names.get(f.id), f.note) : f)));
}

const starred = (room, ids) => room.listeners != null && Array.isArray(room.host_ids) && room.host_ids.some((id) => ids.has(id));

/** Live ships of starred hosts first (marked fav), everything else after, each in its own order. */
export function favoritesFirst(rooms, favs) {
  if (!favs.length) return rooms;
  const ids = new Set(favs.map((f) => f.id));
  const top = rooms.filter((r) => starred(r, ids)).map((r) => ({ ...r, fav: true }));
  return top.length ? [...top, ...rooms.filter((r) => !starred(r, ids))] : rooms;
}

/** Starred ships on the dial that haven't been announced yet. */
export const freshFavRooms = (deck, seen) => deck.filter((r) => r.fav && !seen.has(r.id));
