// node --test tests/*.mjs — beaming a friend aboard.
import test from "node:test";
import assert from "node:assert/strict";
import { beamUrl, cleanTitle, readBeam, sendBeam } from "../public/js/beam.js";

const bands = new Set(["music", "late night"]);
const has = (b) => bands.has(b);

test("a beam link round-trips id, band and title", () => {
  const url = beamUrl("https://space-radio-fm.vercel.app", { id: "1yJAPwQqZoNGb", title: "Late night guitar & talk" }, "late night");
  const beam = readBeam(new URL(url).search, has);
  assert.deepEqual({ ...beam }, { id: "1yJAPwQqZoNGb", band: "late night", title: "Late night guitar & talk" });
});

test("junk beams are ignored; unknown bands dropped; titles cleaned", () => {
  assert.equal(readBeam("?beam=../../x", has), null);
  assert.equal(readBeam("?beam=", has), null);
  assert.equal(readBeam("", has), null);
  assert.equal(readBeam("?beam=1yJAPwQqZoNGb&band=hack", has).band, null);
  assert.equal(readBeam("?beam=1yJAPwQqZoNGb", has).title, "Beamed room");
  assert.equal(cleanTitle("Hi‮ there\u0007"), "Hi there");
  assert.equal(cleanTitle("x".repeat(200)).length, 80);
});

test("send: share sheet on phones, clipboard otherwise, honest failure", async () => {
  const calls = [];
  const nav = { share: async (d) => calls.push(["share", d.url]), clipboard: { writeText: async (u) => calls.push(["copy", u]) } };
  assert.equal(await sendBeam("u1", "t", { phone: true, nav }), "shared");
  assert.equal(await sendBeam("u2", "t", { phone: false, nav }), "copied");
  const abort = { share: async () => { throw Object.assign(new Error("x"), { name: "AbortError" }); }, clipboard: nav.clipboard };
  assert.equal(await sendBeam("u3", "t", { phone: true, nav: abort }), "cancelled");
  assert.equal(await sendBeam("u4", "t", { phone: false, nav: { clipboard: { writeText: async () => { throw new Error("no"); } } } }), "failed");
  assert.deepEqual(calls, [["share", "u1"], ["copy", "u2"]]);
});
