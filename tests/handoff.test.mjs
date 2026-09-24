// node --test tests/*.mjs — the walkie-talkie handoff QR.
import test from "node:test";
import assert from "node:assert/strict";
import { qrPath } from "../public/js/handoff.js";
import { spaceUrl } from "../public/js/rooms.js";

test("QR for a Space link is a real, square, non-empty code", () => {
  const url = spaceUrl("1YqKDqWqdPLxV");
  const { size, d } = qrPath(url);
  assert.equal((size - 17) % 4, 0, "QR sizes are 21, 25, 29…");
  assert.ok(size >= 21);
  const modules = d.split("M").length - 1;
  assert.ok(modules > size * size * 0.3 && modules < size * size * 0.7, `dark modules: ${modules}`);
  assert.deepEqual(qrPath(url), { size, d });
});

test("the QR carries the canonical link, not the docked /peek page", () => {
  const url = spaceUrl("1YqKDqWqdPLxV");
  assert.equal(url, "https://x.com/i/spaces/1YqKDqWqdPLxV");
  assert.notDeepEqual(qrPath(url), qrPath(`${url}/peek`));
});
