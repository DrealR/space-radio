// node --test tests/*.mjs — the bridge scope's layout.
import test from "node:test";
import assert from "node:assert/strict";
import { blipLabel, blipLayout, byCrowd, SWEEP_SECONDS } from "../public/js/radar-model.js";

const room = (id, listeners, speakers = 0, extra = {}) => ({ id, title: id, listeners, speakers, ...extra });
const dist = (b) => Math.hypot(b.x - 50, b.y - 50);

test("busier ships sit nearer the centre; unknown crowds park on the rim", () => {
  const [big, small, preset] = blipLayout([room("1bigRoomAaaa", 500), room("1smallRoomBb", 3), room("1presetRoomC", null, 0, { source: "yours" })], null);
  assert.ok(dist(big) < dist(small), "big crowd is closer to centre");
  assert.ok(dist(preset) > dist(small), "presets sit outside live rooms");
  assert.equal(preset.kind, "mine");
  assert.ok(big.size > small.size);
});

test("every blip stays inside the scope, keeps its bearing, and is frozen", () => {
  const rooms = Array.from({ length: 40 }, (_, i) => room(`1room${String(i).padStart(7, "x")}`, i * 7));
  const blips = blipLayout(rooms, rooms[3].id);
  for (const b of blips) {
    assert.ok(dist(b) <= 50, `${b.id} inside`);
    assert.ok(b.delay >= 0 && b.delay < SWEEP_SECONDS);
    assert.ok(Object.isFrozen(b));
  }
  assert.equal(blips.filter((b) => b.current).length, 1);
  const again = blipLayout(rooms.map((r) => ({ ...r, listeners: r.listeners + 50 })), null);
  const bearing = (b) => Math.atan2(b.y - 50, b.x - 50);
  again.forEach((b, i) => {
    const turn = Math.abs(bearing(b) - bearing(blips[i])) % (2 * Math.PI);
    assert.ok(Math.min(turn, 2 * Math.PI - turn) < 0.01, `${b.id} keeps its bearing as crowds change`);
  });
});

test("labels and tab order", () => {
  assert.equal(blipLabel(room("1a", 12, 3, { title: "Ball Talk" })), "Ball Talk · 12 aboard · 3 on the mic");
  assert.equal(blipLabel(room("1a", 12, 0, { title: "Quiet" })), "Quiet · 12 aboard");
  assert.equal(blipLabel(room("1a", null, 0, { title: "Mine" })), "Mine · your preset");
  assert.equal(blipLabel(room("1a", null, 0, { title: "Hi", beamed: true })), "Hi · beamed in");
  const input = [room("a", 1), room("b", 9), room("c", null)];
  assert.deepEqual(byCrowd(input).map((r) => r.id), ["b", "a", "c"]);
  assert.deepEqual(input.map((r) => r.id), ["a", "b", "c"], "input untouched");
});
