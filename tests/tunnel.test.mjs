// node --test tests/*.mjs — the docking tunnel between two radios, the pure half.
import test from "node:test";
import assert from "node:assert/strict";
import { DOCK_STARS, LOST_SECONDS, TONES, beatState, dockLabel, dockUrl, freshTone, isToken, makeShip, makeToken,
  nextTone, peerView, readDock } from "../public/js/dock-model.js";

const bytes = (...b) => Uint8Array.from(b);

test("dock codes: Hail Mary star names, two digits, a secret the server checks the same way", () => {
  const token = makeToken(bytes(0, 42, 0x3f, 0x9a, 0x0c, 0x1b, 0x2d, 0x4e));
  assert.equal(token, "ERID-42.3f9a0c1b2d4e");
  assert.ok(isToken(token));
  assert.equal(dockLabel(token), "ERID-42");
  assert.equal(makeToken(bytes(3, 7, 1, 2, 3, 4, 5, 6)).split(".")[0], "BLIPA-07");
  assert.ok(DOCK_STARS.every((s) => /^[A-Z]{3,6}$/.test(s)), "every star fits the server's code shape");
  for (let i = 0; i < 200; i++) assert.ok(isToken(makeToken(crypto.getRandomValues(new Uint8Array(8)))));
  assert.equal(makeShip(bytes(1, 2, 3, 4, 5, 6, 7, 8)), "0102030405060708");
});

test("dock links round-trip; junk is ignored", () => {
  const url = dockUrl("https://space-radio-fm.vercel.app", "TAU-05.a1b2c3d4e5f6");
  assert.equal(readDock(new URL(url).search), "TAU-05.a1b2c3d4e5f6");
  for (const bad of ["?dock=tau-05.a1b2c3d4e5f6", "?dock=TAU-05", "?dock=../../x", "", "?beam=x"]) assert.equal(readDock(bad), null, bad);
  assert.equal(dockLabel("nope"), "");
});

test("tones: four words, numbered so each plays once; COME HERE carries your room", () => {
  assert.deepEqual(Object.keys(TONES), ["fist", "amaze", "come", "onward"]);
  const room = { id: "1yJAPwQqZoNGb", title: "Ball Talk", listeners: 104, extra: "dropped" };
  assert.deepEqual(nextTone("fist", 0, room), { kind: "fist", seq: 1, room: null });
  assert.deepEqual(nextTone("come", 4, room), { kind: "come", seq: 5, room: { id: room.id, title: "Ball Talk", listeners: 104 } });
  assert.equal(nextTone("shout", 0, room), null);
  const peer = { age: 1, state: { tone: { kind: "amaze", seq: 7 } } };
  assert.equal(freshTone(peer, 6).seq, 7);
  assert.equal(freshTone(peer, 7), null, "already heard");
  assert.equal(freshTone({ age: 1, state: { tone: { kind: "nope", seq: 9 } } }, 0), null);
});

test("what the tunnel says about your partner", () => {
  assert.equal(peerView(null).status, "waiting");
  assert.equal(peerView({ age: 1, state: { left: true } }).status, "left");
  assert.equal(peerView({ age: LOST_SECONDS + 1, state: {} }).status, "lost");
  const docked = peerView({ age: 2, state: { room: { id: "1a", title: "Hi" }, air: true, band: "music" } });
  assert.deepEqual(docked, { status: "docked", room: { id: "1a", title: "Hi" }, air: true, band: "music" });
});

test("a beat carries only what the partner needs", () => {
  const s = beatState({ room: { id: "1a", title: "x".repeat(300), listeners: 5, ticket: "secret" }, band: "music", air: 1 });
  assert.deepEqual(Object.keys(s).sort(), ["air", "band", "left", "room", "tone"]);
  assert.equal(s.room.title.length, 120);
  assert.equal(s.room.ticket, undefined, "tickets stay home");
  assert.equal(s.air, true);
  assert.deepEqual(beatState({ left: true }), { room: null, band: "", air: false, tone: null, left: true });
});
