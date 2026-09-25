// node --test tests/*.mjs — TRANSMIT: a tuned room goes to the X Factory as a post idea.
import test from "node:test";
import assert from "node:assert/strict";
import { STATION_URL, TOPIC_MAX, transmitUrl } from "../public/js/transmit.js";

const room = (title) => ({ id: "1yJAPwQqZoNGb", title });

test("a tuned room becomes a station link to the factory, host included when known", () => {
  const url = new URL(transmitUrl(room("Late night guitar & talk"), "DejiBasho"));
  assert.equal(`${url.origin}${url.pathname}`, STATION_URL);
  assert.equal(url.hash, "#factory");
  assert.equal(url.searchParams.get("from"), "radio");
  assert.equal(url.searchParams.get("topic"), "Late night guitar & talk");
  assert.equal(url.searchParams.get("host"), "DejiBasho");
});

test("the station lives on reemifai.org", () => {
  assert.equal(STATION_URL, "https://reemifai.org/station");
});

test("an unknown or junk host is left out", () => {
  for (const host of [undefined, null, "", "not a handle", "waytoolonghandle16", "<script>"]) {
    const url = new URL(transmitUrl(room("Chill"), host));
    assert.equal(url.searchParams.has("host"), false, String(host));
  }
  assert.equal(new URL(transmitUrl(room("Chill"), "@space_ship1")).searchParams.get("host"), "space_ship1");
});

test("no room, or no real title, means nothing to transmit", () => {
  assert.equal(transmitUrl(null), null);
  for (const title of ["", "   ", "\u0007", "Untitled room", "Preset room", "Beamed room"]) {
    assert.equal(transmitUrl(room(title)), null, JSON.stringify(title));
  }
});

test("the topic is cleaned and capped without splitting an emoji", () => {
  const dirty = new URL(transmitUrl(room("  late\n\tnight\u0000 ‮radio  ")));
  assert.equal(dirty.searchParams.get("topic"), "late night radio");
  const long = new URL(transmitUrl(room("🛸".repeat(TOPIC_MAX + 30)))).searchParams.get("topic");
  assert.equal(Array.from(long).length, TOPIC_MAX);
  assert.ok(long.endsWith("…"));
  assert.ok(!long.includes("�"));
});

test("transmitting never edits the room", () => {
  const r = Object.freeze(room("Frozen"));
  assert.ok(transmitUrl(r, "host"));
  assert.equal(r.title, "Frozen");
});
