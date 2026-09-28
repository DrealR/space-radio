import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const appSource = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const requestCounter = "let bandRequest = 0;";
const start = appSource.indexOf("async function tuneBand(");
const end = appSource.indexOf("\nfunction tick()", start);
assert.ok(appSource.includes(requestCounter), "band request counter is present in app.js");
assert.ok(start >= 0 && end > start, "tuneBand() is present in app.js");
const tuneBandSource = appSource.slice(start, end);

function makeRadio(initialState, fetchBand) {
  return new Function("initialState", "fetchBand", "parseSpaceId", `
    let state = initialState;
    ${requestCounter}
    const set = (patch) => { state = { ...state, ...patch }; };
    const crackle = () => {};
    const savePrefs = () => {};
    const deckFor = (live) => live;
    const announceTune = () => {};
    const fuel = { refresh() {} };
    ${tuneBandSource}
    return { tuneBand, get state() { return state; } };
  `)(initialState, fetchBand, (id) => id);
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test("a late response from an earlier band cannot replace the selected band's rooms", async () => {
  const music = deferred();
  const science = deferred();
  const radio = makeRadio({ band: "anything", live: [], loading: false, problems: [], currentId: null },
    (band) => band === "music" ? music.promise : science.promise);

  const musicTune = radio.tuneBand("music");
  const scienceTune = radio.tuneBand("science");
  science.resolve({ data: [{ id: "science-space" }], meta: {} });
  await scienceTune;
  music.resolve({ data: [{ id: "music-space" }], meta: {} });
  await musicTune;

  assert.equal(radio.state.band, "science");
  assert.deepEqual(radio.state.live.map((room) => room.id), ["science-space"]);
});
