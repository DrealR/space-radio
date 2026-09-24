// node --test tests/  — pure helpers behind the dial.
import test from "node:test";
import assert from "node:assert/strict";
import {
  GRILLE_DOTS, MAX_PRESETS, addPreset, ago, bandLabel, buildDeck, frequency, grillePlan,
  parseSpaceId, position, removePreset, signalBars, sortRooms,
} from "../public/js/rooms.js";

const room = (id, listeners, started = "2026-09-23T20:00:00Z", extra = {}) =>
  ({ id, title: id, listeners, speakers: 0, hosts: 1, started_at: started, source: "x-api", ...extra });
const A = room("1YqKDqWqdPLxV", 40, "2026-09-23T19:00:00Z");
const B = room("1OwxWzqXyLbJQ", 5, "2026-09-23T21:00:00Z");
const C = room("1gqxvQoBjBVJB", 1, "2026-09-23T20:30:00Z");

test("sorts: busy, fresh, cozy (lonely hosts last)", () => {
  assert.deepEqual(sortRooms([B, A, C], "busy").map((r) => r.listeners), [40, 5, 1]);
  assert.deepEqual(sortRooms([A, B, C], "fresh").map((r) => r.id), [B.id, C.id, A.id]);
  assert.deepEqual(sortRooms([A, B, C], "cozy").map((r) => r.listeners), [5, 40, 1]);
});

test("sorting never edits the input", () => {
  const input = [B, A];
  sortRooms(input, "busy");
  assert.deepEqual(input, [B, A]);
});

test("deck = live rooms then presets not already live", () => {
  const presets = [{ id: A.id, title: "dup" }, { id: "1abcdefghXYZ", title: "mine" }];
  const d = buildDeck([B, A], "busy", presets);
  assert.deepEqual(d.map((r) => r.id), [A.id, B.id, "1abcdefghXYZ"]);
  assert.equal(d[2].source, "yours");
  assert.equal(d[2].listeners, null);
  assert.equal(d[2].url, "https://x.com/i/spaces/1abcdefghXYZ");
});

test("dial spreads rooms across the FM band on odd tenths", () => {
  assert.equal(position(0, 1), 50);
  assert.equal(position(0, 5), 4);
  assert.equal(position(4, 5), 96);
  assert.equal(frequency(0, 10), "88.1");
  assert.equal(frequency(9, 10), "107.9");
  for (let i = 0; i < 10; i++) assert.match(frequency(i, 10), /\.[13579]$/);
});

test("ago and signal", () => {
  const now = Date.parse("2026-09-23T21:30:00Z");
  assert.equal(ago("2026-09-23T21:30:20Z", now), "JUST STARTED");
  assert.equal(ago("2026-09-23T21:18:00Z", now), "LIVE 12M");
  assert.equal(ago("2026-09-23T19:25:00Z", now), "LIVE 2H05");
  assert.equal(ago("", now), "");
  assert.equal(signalBars(null), 0);
  assert.equal(signalBars(1), 1);
  assert.equal(signalBars(250), 5);
});

test("grille: one dot per person, hosts and mics first, same crowd for same room", () => {
  const plan = grillePlan({ ...A, listeners: 10, hosts: 1, speakers: 3 });
  const count = (k) => plan.cells.filter((c) => c === k).length;
  assert.equal(plan.cells.length, GRILLE_DOTS);
  assert.deepEqual([count("host"), count("mic"), count("ear")], [1, 3, 6]);
  assert.deepEqual(grillePlan({ ...A, listeners: 10, hosts: 1, speakers: 3 }).cells, plan.cells);
  assert.notDeepEqual(grillePlan({ ...B, listeners: 10, hosts: 1, speakers: 3 }).cells, plan.cells);
});

test("grille scales big rooms and knows nothing about presets", () => {
  const big = grillePlan({ ...A, listeners: 1000, hosts: 2, speakers: 8 });
  assert.equal(big.perDot, 11);
  assert.ok(big.cells.filter(Boolean).length <= GRILLE_DOTS);
  assert.equal(grillePlan({ ...A, listeners: null }).known, false);
});

test("parse links and ids, reject junk", () => {
  assert.equal(parseSpaceId("https://x.com/i/spaces/1YqKDqWqdPLxV?s=20"), "1YqKDqWqdPLxV");
  assert.equal(parseSpaceId("twitter.com/i/spaces/1YqKDqWqdPLxV"), "1YqKDqWqdPLxV");
  assert.equal(parseSpaceId("1YqKDqWqdPLxV"), "1YqKDqWqdPLxV");
  for (const bad of ["", "x.com/home", "<img>", null]) assert.equal(parseSpaceId(bad), null);
});

test("presets are immutable, deduped and capped", () => {
  const empty = [];
  const one = addPreset(empty, A.id, "a");
  assert.deepEqual(empty, []);
  assert.equal(one.presets.length, 1);
  assert.match(addPreset(one.presets, A.id, "again").error, /Already/);
  let full = [];
  for (let i = 0; i < MAX_PRESETS; i++) full = addPreset(full, `1abcdefgh${i}ZZ`, "").presets;
  assert.match(addPreset(full, B.id, "").error, /full/);
  assert.equal(removePreset(one.presets, A.id).length, 0);
});

test("band labels fit the keys", () => {
  assert.equal(bandLabel("anything"), "ANY");
  assert.equal(bandLabel("late night"), "LATE");
  assert.equal(bandLabel("music"), "MUSIC");
});

test("English-only keeps en, other and unknown; drops other languages", async () => {
  const { onlyEnglish, langLabel } = await import("../public/js/rooms.js");
  const rooms = ["en", "other", "", undefined, "ja", "ro", "EN"].map((lang, i) => ({ id: `r${i}`, lang }));
  assert.deepEqual(onlyEnglish(rooms, true).map((r) => r.id), ["r0", "r1", "r2", "r3", "r6"]);
  assert.equal(onlyEnglish(rooms, false).length, rooms.length);
  assert.deepEqual(["en", "other", "", "ja"].map(langLabel), ["EN", "", "", "JA"]);
});

test("space links: canonical, /peek for the docked window, null for anything else", async () => {
  const { spaceUrl, peekUrl, intentUrl, presetRoom } = await import("../public/js/rooms.js");
  assert.equal(spaceUrl("1YqKDqWqdPLxV"), "https://x.com/i/spaces/1YqKDqWqdPLxV");
  assert.equal(peekUrl("1YqKDqWqdPLxV"), "https://x.com/i/spaces/1YqKDqWqdPLxV/peek");
  for (const bad of ["", null, undefined, "x.com/i/spaces/1YqKDqWqdPLxV", "1YqK/../evil", "short", "<img>"]) {
    assert.equal(spaceUrl(bad), null, String(bad));
    assert.equal(peekUrl(bad), null, String(bad));
    assert.equal(intentUrl(bad), null, String(bad));
  }
  assert.equal(presetRoom({ id: "1YqKDqWqdPLxV", title: "" }).url, spaceUrl("1YqKDqWqdPLxV"));
  assert.equal(intentUrl("1YqKDqWqdPLxV"),
    "intent://x.com/i/spaces/1YqKDqWqdPLxV#Intent;scheme=https;package=com.twitter.android;"
    + "S.browser_fallback_url=https%3A%2F%2Fx.com%2Fi%2Fspaces%2F1YqKDqWqdPLxV;end");
});
