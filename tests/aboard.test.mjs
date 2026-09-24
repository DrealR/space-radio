// node --test tests/*.mjs — the crew manifest's buttons act on the room it names.
import test from "node:test";
import assert from "node:assert/strict";
import { AIR_IDLE } from "../public/js/airlock.js";
import { crewOptions } from "../public/js/aboard.js";

const A = { id: "1YqKDqWqdPLxV", title: "Night owls" };
const B = { id: "1OwxWzqXyLbJQ", title: "Morning show" };
globalThis.document = { getElementById: (id) => ({ id }) };

function setup(kind) {
  let state = { air: AIR_IDLE, currentId: A.id, rosters: {}, ended: [], learned: { crew: true } };
  let calls = [];
  const note = (name) => (...args) => { calls = [...calls, [name, ...args]]; };
  const app = {
    get state() { return state; },
    device: { kind },
    current: () => [A, B].find((r) => r.id === state.currentId),
    deck: () => [A, B],
    select: (id) => { state = { ...state, currentId: id }; calls = [...calls, ["select", id]]; },
    copy: () => ({ ptt: { text: "PUSH TO LISTEN", sub: "", mode: "intercept" }, here: false, linedUp: false }),
    channelLabel: () => "CH 01 · 88.1 FM", set: note("set"), step: note("step"), render: note("render"), sfxOk: () => false,
  };
  const launch = { push: note("push"), leaveForX: note("leaveForX") };
  const crewApi = { isCrewOpen: () => true, closeCrew: note("closeCrew") };
  return { app, launch, crewApi, get calls() { return calls; }, move: (id) => { state = { ...state, currentId: id }; } };
}

test("phone: OPEN IN X leaves for X, then closes the sheet so the radio's question isn't covered", () => {
  const s = setup("phone");
  crewOptions(s.app, s.launch, A, s.crewApi).onOpenX({});
  assert.deepEqual(s.calls.map((c) => c[0]), ["leaveForX", "closeCrew"]);
});

test("computer: OPEN IN X is only a new tab; the manifest stays", () => {
  const s = setup("desktop");
  crewOptions(s.app, s.launch, A, s.crewApi).onOpenX({});
  assert.deepEqual(s.calls, []);
});

test("PUSH in the manifest boards the manifest's room, even if SCAN moved the needle", () => {
  const s = setup("desktop");
  const opts = crewOptions(s.app, s.launch, A, s.crewApi);
  s.move(B.id);
  opts.listen.onClick({});
  assert.deepEqual(s.calls.map((c) => c[0]), ["select", "push"]);
  assert.equal(s.calls[0][1], A.id);
  assert.equal(opts.listen.href, `https://x.com/i/spaces/${A.id}`);
});
