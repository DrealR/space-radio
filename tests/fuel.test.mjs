// node --test tests/*.mjs — the fuel gauge's arithmetic and warnings.
import test from "node:test";
import assert from "node:assert/strict";
import { COSTS, FREE, fuelLevel, fuelWarning, money } from "../public/js/fuel.js";

test("money reads like a price tag", () => {
  assert.equal(money(0.423), "42¢");
  assert.equal(money(0), "0¢");
  assert.equal(money(1.1), "$1.10");
});

test("the tank: ok, low at 80%, empty at the cap", () => {
  assert.equal(fuelLevel(null).level, "unknown");
  assert.equal(fuelLevel({ spent: 0, cap: 0 }).level, "unknown");
  assert.deepEqual(fuelLevel({ spent: 0.42, cap: 1.1 }).words, "42¢ / $1.10");
  assert.equal(fuelLevel({ spent: 0.5, cap: 1 }).level, "ok");
  assert.equal(fuelLevel({ spent: 0.8, cap: 1 }).level, "low");
  assert.equal(fuelLevel({ spent: 1.3, cap: 1 }).level, "empty");
  assert.equal(fuelLevel({ spent: 1.3, cap: 1 }).ratio, 1);
});

test("each warning shows once a day", () => {
  assert.equal(fuelWarning("ok", {}), null);
  assert.equal(fuelWarning("low", {}).key, "low");
  assert.equal(fuelWarning("low", { low: true }), null);
  assert.equal(fuelWarning("empty", { low: true }).key, "empty");
  assert.equal(fuelWarning("empty", { empty: true }), null);
});

test("the cost sheet names what's paid and what's free", () => {
  assert.ok(COSTS.some(([what]) => /WHO'S HERE/.test(what)));
  assert.ok(COSTS.some(([, price]) => price === "free"));
  for (const free of ["RADAR", "PUSH", "DOCK", "OPEN IN X"]) assert.ok(FREE.includes(free), free);
});
