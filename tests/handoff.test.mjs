// node --test tests/*.mjs — the walkie-talkie handoff.
import test from "node:test";
import assert from "node:assert/strict";
import { joinCopy, qrPath } from "../public/js/handoff.js";

test("computer says listen and points to MIC; phone says join", () => {
  assert.equal(joinCopy({ phone: false, listening: false }).text, "PUSH TO LISTEN");
  assert.match(joinCopy({ phone: false, listening: false }).sub, /MIC/);
  assert.equal(joinCopy({ phone: false, listening: true }).text, "LISTENING");
  assert.equal(joinCopy({ phone: true, listening: false }).text, "PUSH TO JOIN");
  assert.match(joinCopy({ phone: true, listening: false }).sub, /request the mic/);
  assert.equal(joinCopy({ phone: true, listening: true }).text, "YOU'RE IN");
});

test("QR for a Space link is a real, square, non-empty code", () => {
  const { size, d } = qrPath("https://x.com/i/spaces/1YqKDqWqdPLxV");
  assert.equal((size - 17) % 4, 0, "QR sizes are 21, 25, 29…");
  assert.ok(size >= 21);
  const modules = d.split("M").length - 1;
  assert.ok(modules > size * size * 0.3 && modules < size * size * 0.7, `dark modules: ${modules}`);
  assert.deepEqual(qrPath("https://x.com/i/spaces/1YqKDqWqdPLxV"), { size, d });
});
