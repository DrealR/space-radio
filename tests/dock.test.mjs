// node --test tests/*.mjs — docking X beside the radio, and telling phones from computers.
import test from "node:test";
import assert from "node:assert/strict";
import { deviceKind, dockFeatures, dockable, inAppBrowser, isAndroid, isStandalone } from "../public/js/dock.js";

// A maximized 1440x900 browser: 80px of toolbar, no side chrome.
const screen = { screenX: 0, screenY: 0, outerWidth: 1440, outerHeight: 875, innerWidth: 1440, innerHeight: 795,
                 availLeft: 0, availTop: 25, availWidth: 1440, availHeight: 875 };
const radio = { left: 282, right: 722, top: 72 };
const parse = (features) => Object.fromEntries(features.split(",").map((kv) => kv.split("=")))

test("docks right of the radio when it fits (over the flight manual)", () => {
  const { features, side } = dockFeatures(screen, radio);
  const f = parse(features);
  assert.equal(side, "right");
  assert.equal(f.popup, "yes");
  assert.deepEqual([f.width, f.height, f.left], ["440", "780", String(722 + 16)]);
  // 80px of toolbar + 72px down the page, pulled up so all 780px fit above the dock.
  assert.equal(f.top, String(25 + 875 - 780));
  const tall = parse(dockFeatures({ ...screen, availHeight: 1415, outerHeight: 1415, innerHeight: 1335 }, radio).features);
  assert.equal(tall.top, String(0 + 80 + 72));
});

test("docks left when the right side is full, over when neither fits", () => {
  const narrow = { ...screen, outerWidth: 1000, innerWidth: 1000, availWidth: 1000 };
  const left = dockFeatures(narrow, { left: 500, right: 940, top: 10 });
  assert.equal(left.side, "left");
  assert.equal(parse(left.features).left, String(500 - 16 - 440));
  const over = dockFeatures(narrow, { left: 280, right: 720, top: 10 });
  assert.equal(over.side, "over");
  assert.equal(parse(over.features).left, String(1000 - 440));
});

test("top is clamped to the screen, and height to the available space", () => {
  const low = dockFeatures(screen, { ...radio, top: 700 });
  const f = parse(low.features);
  assert.equal(Number(f.top) + Number(f.height), 25 + 875);
  const short = dockFeatures({ ...screen, availHeight: 600 }, { ...radio, top: -300 });
  const s = parse(short.features);
  assert.equal(s.height, "560");
  assert.equal(s.top, String(25 + 600 - 560)); // scrolled past the radio's top: window top, then clamped
  const roomy = parse(dockFeatures({ ...screen, availHeight: 1400 }, { ...radio, top: -300 }).features);
  assert.equal(roomy.top, "80");
});

test("second monitor to the left: negative coordinates stay on that screen", () => {
  const left = { ...screen, screenX: -1920, availLeft: -1920, availWidth: 1920, outerWidth: 1920, innerWidth: 1920 };
  const { features, side } = dockFeatures(left, { left: 740, right: 1180, top: 50 });
  const f = parse(features);
  assert.equal(side, "right");
  assert.equal(f.left, String(-1920 + 1180 + 16));
  assert.ok(Number(f.left) + 440 <= 0);
});

test("all numbers are integers, even with fractional chrome", () => {
  const odd = { ...screen, outerWidth: 1441, innerWidth: 1438, screenX: 10.5 };
  const f = parse(dockFeatures(odd, { left: 282.3, right: 722.7, top: 71.6 }).features);
  for (const key of ["width", "height", "left", "top"]) assert.match(f[key], /^-?\d+$/);
});

test("device kinds: iPhone is a phone; iPad, touch laptops and desktops dock", () => {
  assert.equal(deviceKind({ coarse: true, hoverNone: true, shortSide: 390 }), "phone");
  assert.equal(deviceKind({ coarse: true, hoverNone: true, shortSide: 820 }), "desktop"); // iPad
  assert.equal(deviceKind({ coarse: true, hoverNone: false, shortSide: 800 }), "desktop"); // touch laptop
  assert.equal(deviceKind({ coarse: false, hoverNone: false, shortSide: 900 }), "desktop");
  assert.equal(dockable({ coarse: true, hoverNone: true }), false); // iPad: new tab, never "beside"
  assert.equal(dockable({ coarse: true, hoverNone: false }), true);
});

test("in-app browsers, Android and standalone detection", () => {
  assert.equal(inAppBrowser("Mozilla/5.0 (iPhone) Instagram 300.0"), true);
  assert.equal(inAppBrowser("Mozilla/5.0 [FBAN/FBIOS;FBAV/400]"), true);
  assert.equal(inAppBrowser("Mozilla/5.0 (Macintosh) Safari/605.1"), false);
  assert.equal(inAppBrowser(undefined), false);
  assert.equal(isAndroid("Mozilla/5.0 (Linux; Android 14; Pixel 8)"), true);
  assert.equal(isAndroid("Mozilla/5.0 (iPhone)"), false);
  const media = (on) => () => ({ matches: on });
  assert.equal(isStandalone(media(true), {}), true);
  assert.equal(isStandalone(media(false), { standalone: true }), true);
  assert.equal(isStandalone(media(false), {}), false);
  assert.equal(isStandalone(() => { throw new Error("no matchMedia"); }, {}), false);
});
