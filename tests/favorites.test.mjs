// node --test tests/*.mjs — favorite hosts: starred in this browser, matched against rooms already on the dial.
import test from "node:test";
import assert from "node:assert/strict";
import { MAX_FAVS, favFrom, favLabel, favoritesFirst, freshFavRooms, nameFavs, readFavs, removeFav, toggleFav } from "../public/js/favorites.js";

const ID_A = "1YqKDqWqdPLxV";
const flight = Object.freeze({ id: ID_A, title: "Late night lo-fi", host: "", hostId: "", hostIds: ["11", "22"] });

test("a star comes from a flight: the named host when the crew was scanned, else the first host X listed", () => {
  assert.deepEqual({ ...favFrom(flight) }, { id: "11", handle: "", note: "Late night lo-fi" });
  assert.deepEqual({ ...favFrom({ ...flight, host: "sr26_captain", hostId: "22" }) },
    { id: "22", handle: "sr26_captain", note: "Late night lo-fi" });
  assert.equal(favFrom({ ...flight, hostIds: [] }), null, "a preset or beamed room: host unknown");
  assert.equal(favLabel({ id: "11", handle: "", note: "Late night lo-fi" }), "the host of “Late night lo-fi”");
  assert.equal(favLabel({ id: "22", handle: "sr26_captain", note: "x" }), "@sr26_captain");
});

test("toggle adds and removes without editing the list; bounded", () => {
  const none = Object.freeze([]);
  const on = toggleFav(none, favFrom(flight));
  assert.equal(on.on, true);
  assert.equal(none.length, 0);
  const off = toggleFav(on.favs, favFrom(flight));
  assert.equal(off.on, false);
  assert.equal(off.favs.length, 0);
  let full = [];
  for (let k = 0; k < MAX_FAVS; k++) full = toggleFav(full, { id: String(k + 100), handle: "", note: "n" }).favs;
  const over = toggleFav(full, { id: "9", handle: "", note: "n" });
  assert.match(over.error, /most/);
  assert.equal(over.favs, full);
  assert.equal(removeFav(full, "100").length, MAX_FAVS - 1);
});

test("stored stars are rebuilt, not trusted", () => {
  const raw = [{ id: "11", handle: "sr26_captain", note: "Room‮" }, { id: "11", handle: "", note: "dupe" },
               { id: "abc" }, null, { id: "12", handle: "<b>", note: 5 }];
  assert.deepEqual(readFavs(raw).map((f) => ({ ...f })),
    [{ id: "11", handle: "sr26_captain", note: "Room" }, { id: "12", handle: "", note: "" }]);
  assert.deepEqual(readFavs({}), []);
});

test("a later crew scan names a star that only had an id", () => {
  const favs = [Object.freeze({ id: "11", handle: "", note: "Room" })];
  const named = nameFavs(favs, [{ hostId: "11", host: "sr26_captain" }, { hostId: "", host: "" }]);
  assert.equal(named[0].handle, "sr26_captain");
  assert.equal(favs[0].handle, "");
  assert.equal(nameFavs(named, []), named, "nothing new: the same list");
});

test("live ships of starred hosts surface first, in their own order; presets never match", () => {
  const rooms = [
    { id: "a", listeners: 90, host_ids: ["1"] },
    { id: "b", listeners: 12, host_ids: ["2", "11"] },
    { id: "c", listeners: 5, host_ids: ["3"] },
    { id: "d", listeners: 3, host_ids: ["11"] },
    { id: "p", listeners: null, title: "preset" },
  ];
  const favs = [{ id: "11", handle: "", note: "" }];
  const deck = favoritesFirst(rooms, favs);
  assert.deepEqual(deck.map((r) => r.id), ["b", "d", "a", "c", "p"]);
  assert.deepEqual(deck.map((r) => Boolean(r.fav)), [true, true, false, false, false]);
  assert.equal(rooms[1].fav, undefined, "rooms are copied, not edited");
  assert.equal(favoritesFirst(rooms, []), rooms, "no stars: the deck as it was");
  assert.deepEqual(freshFavRooms(deck, new Set(["b"])).map((r) => r.id), ["d"]);
});
