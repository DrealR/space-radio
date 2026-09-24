// node --test tests/*.mjs — rebuilding a row of buttons never drops a keyboard user to <body>.
import test from "node:test";
import assert from "node:assert/strict";
import { replaceKeepingFocus } from "../public/js/dom.js";

function button(key, extra = {}) {
  return { dataset: key == null ? {} : { key }, disabled: false, focused: 0, focus() { this.focused += 1; }, ...extra };
}

function box(children) {
  let kids = children;
  return {
    get kids() { return kids; },
    contains: (n) => kids.includes(n),
    replaceChildren: (...nodes) => { kids = nodes; },
    querySelectorAll: () => kids.filter((n) => Object.keys(n.dataset).length),
    querySelector: () => kids[0] || null,
  };
}

test("focus moves to the rebuilt twin of the pressed button", () => {
  const old = [button("music"), button("tech")];
  const row = box(old);
  const fresh = [button("music"), button("tech")];
  replaceKeepingFocus(row, fresh, { doc: { activeElement: old[1] } });
  assert.deepEqual(fresh.map((b) => b.focused), [0, 1]);
});

test("focus outside the row is left alone", () => {
  const row = box([button("music")]);
  const fresh = [button("music")];
  replaceKeepingFocus(row, fresh, { doc: { activeElement: button("elsewhere") } });
  assert.equal(fresh[0].focused, 0);
});

test("a vanished or disabled twin hands focus to the fallback", () => {
  const old = [button("a"), button("b")];
  const row = box(old);
  const fresh = [button("a"), button("b", { disabled: true })];
  replaceKeepingFocus(row, fresh, { doc: { activeElement: old[1] }, fallback: (b) => b.kids[0] });
  assert.deepEqual(fresh.map((b) => b.focused), [1, 0]);
  const chips = box([button(null, { dataset: { chip: "nosound" } })]);
  const card = [button(null, { dataset: { chip: "heard" } })];
  replaceKeepingFocus(chips, card, { key: "chip", doc: { activeElement: chips.kids[0] }, fallback: (b) => b.kids[0] });
  assert.equal(card[0].focused, 1);
});
