// node --test tests/*.mjs — bands you make yourself.
import test from "node:test";
import assert from "node:assert/strict";
import { MAX_BANDS, addBand, bandKey, isMine, loadBands, makeBand, mergeRooms, normalizeWord, parseWords, removeBand, searchPath } from "../public/js/mybands.js";
import { bandLabel } from "../public/js/rooms.js";

test("words: lowercase, trimmed, same rules as the server", () => {
  assert.equal(normalizeWord("  Open   Mic "), "open mic");
  assert.equal(normalizeWord("#NFL"), "#nfl");
  assert.equal(normalizeWord("$btc"), "$btc");
  for (const bad of ["a", "", "---", "<b>", "café", "x".repeat(31), "hi!"]) assert.equal(normalizeWord(bad), null, bad);
});

test("the path is exactly what the server's canonical check expects", () => {
  assert.equal(searchPath("open mic"), "/api/search?q=open%20mic");
  assert.equal(searchPath("#nfl"), "/api/search?q=%23nfl");
  assert.equal(searchPath("$btc"), "/api/search?q=%24btc");
});

test("parse and make: dedupe, cap at two, name from the first word", () => {
  assert.deepEqual(parseWords("guitar, Guitar, open mic, jazz, blues").words, ["guitar", "open mic"]);
  const { band } = makeBand("", "guitar, acoustic");
  assert.deepEqual({ name: band.name, words: [...band.words] }, { name: "GUITAR", words: ["guitar", "acoustic"] });
  assert.equal(makeBand("detroit!!", "detroit").band.name, "DETROI");
  assert.match(makeBand("x", "hi!").error, /can't be a search word/);
  assert.match(makeBand("x", "  ").error, /at least one/);
});

test("add and remove never edit the list; five at most; names unique", () => {
  const empty = [];
  const one = addBand(empty, makeBand("GTR", "guitar").band);
  assert.equal(empty.length, 0);
  assert.match(addBand(one.bands, makeBand("GTR", "jazz").band).error, /already/);
  let full = [];
  for (let i = 0; i < MAX_BANDS; i++) full = addBand(full, makeBand(`B${i}`, "word").band).bands;
  assert.match(addBand(full, makeBand("ZZ", "word").band).error, /Five/);
  assert.equal(removeBand(one.bands, "GTR").length, 0);
});

test("stored bands are rebuilt, not trusted; keys and labels", () => {
  const raw = [{ name: "gtr", words: ["Guitar"] }, { name: "<x>", words: ["bad!"] }, null, { name: "gtr", words: ["jazz"] }];
  assert.deepEqual(loadBands(raw).map((b) => b.name), ["GTR"]);
  assert.deepEqual(loadBands("nope"), []);
  const key = bandKey({ name: "GUITAR" });
  assert.equal(key, "my:GUITAR");
  assert.ok(isMine(key) && !isMine("music"));
  assert.equal(bandLabel(key), "GUITAR");
  assert.equal(bandLabel("late night"), "LATE");
});

test("merge keeps each room once, first word wins", () => {
  const merged = mergeRooms([[{ id: "a", w: 1 }, { id: "b" }], [{ id: "a", w: 2 }, { id: "c" }], []]);
  assert.deepEqual(merged.map((r) => r.id), ["a", "b", "c"]);
  assert.equal(merged[0].w, 1);
});
