// node --test tests/*.mjs — the crew manifest: reading X's roster honestly and rationing scans.
import test from "node:test";
import assert from "node:assert/strict";
import * as crew from "../public/js/crew.js";
import {
  anchorBox, avatarAt, createCrewStore, initials, metaLine, normalizePerson, noteFor,
  othersCount, personLabel, profileUrl, readCrewReply, rosterSentence, skeletonCount,
  spaceLink, stateFor,
} from "../public/js/crew.js";

const ID = "1YqKDqWqdPLxV";
const AV = "https://pbs.twimg.com/profile_images/1/ava_200x200.jpg";
const AV_SMALL = "https://pbs.twimg.com/profile_images/1/ava_normal.jpg";
const person = (id, username, role, extra = {}) => ({
  id, username, role, name: username.toUpperCase(), avatar: AV, avatar_small: AV_SMALL,
  verified: "", protected: false, profile_url: `https://x.com/${username}`, ...extra,
});
const reply = (data = {}, meta = {}) => ({
  success: true, error: null,
  meta: { fetched_at: "2026-09-24T12:00:00Z", mode: "full", cached: false, ...meta },
  data: {
    id: ID, state: "live", title: "Night owls", listeners: 1204, started_at: "2026-09-24T10:48:00Z",
    lang: "en", url: `https://x.com/i/spaces/${ID}`,
    crew: [person("1", "ada", "host"), person("2", "bo", "cohost"), person("3", "cy", "cohost"),
           person("4", "di", "speaker"), person("5", "ed", "speaker")],
    counts: { hosts: 3, speakers: 8 }, others: 1193, ...data,
  },
});
const failure = (reason) => ({ success: false, data: null, error: "Nope.", meta: { reason } });

test("importing crew.js in node touches no DOM, and the UI API is safe without one", () => {
  for (const name of ["openCrew", "closeCrew", "isCrewOpen", "cachedCrew"]) {
    assert.equal(typeof crew[name], "function", name);
  }
  assert.equal(crew.isCrewOpen(), false);
  assert.equal(crew.cachedCrew(ID), null);
  assert.doesNotThrow(() => crew.openCrew({ id: ID, title: "x" }, {}));
  assert.doesNotThrow(() => crew.closeCrew());
});

test("readCrewReply: host, then co-hosts, then speakers, with counts and others", () => {
  const r = readCrewReply(reply(), ID, 5000);
  assert.equal(r.ok, true);
  const d = r.data;
  assert.equal(d.host.username, "ada");
  assert.deepEqual(d.cohosts.map((p) => p.username), ["bo", "cy"]);
  assert.deepEqual(d.speakers.map((p) => p.username), ["di", "ed"]);
  assert.deepEqual(d.counts, { hosts: 3, speakers: 8 });
  assert.equal(d.others, 1204 - 3 - 8);
  assert.equal(d.url, `https://x.com/i/spaces/${ID}`);
  assert.equal(d.mode, "full");
  assert.equal(d.at, 5000);
  assert.equal(d.host.avatarSmall, AV_SMALL);
  assert.equal(d.host.profileUrl, "https://x.com/ada");
  assert.ok(Object.isFrozen(d) && Object.isFrozen(d.cohosts) && Object.isFrozen(d.host) && Object.isFrozen(d.counts));
});

test("readCrewReply: the client re-orders, dedupes, keeps one host and caps the crew at 30", () => {
  const many = Array.from({ length: 40 }, (_, i) => person(String(100 + i), `s${i}`, "speaker"));
  const crewList = [person("2", "bo", "cohost"), ...many, person("1", "ada", "host"),
                    person("9", "zed", "host"), person("2", "bo", "cohost")];
  const d = readCrewReply(reply({ crew: crewList }), ID).data;
  assert.equal(d.host.username, "ada");
  assert.deepEqual(d.cohosts.map((p) => p.id), ["2"]);
  assert.equal(1 + d.cohosts.length + d.speakers.length, 30);
});

test("readCrewReply: ended and scheduled rooms carry no crew; host-only mode is read from meta", () => {
  const ended = readCrewReply(reply({ state: "ended", listeners: 0 }), ID).data;
  assert.equal(ended.state, "ended");
  assert.equal(ended.host, null);
  assert.deepEqual([...ended.speakers], []);
  assert.equal(readCrewReply(reply({}, { mode: "host-only" }), ID).data.mode, "host-only");
  assert.equal(readCrewReply(reply({}, { mode: "weird" }), ID).data.mode, "full");
});

test("readCrewReply: missing counts are derived from the crew; counts never go below it", () => {
  const d = readCrewReply(reply({ counts: undefined }), ID).data;
  assert.deepEqual(d.counts, { hosts: 3, speakers: 2 });
  const low = readCrewReply(reply({ counts: { hosts: -4, speakers: "8" } }), ID).data;
  assert.deepEqual(low.counts, { hosts: 3, speakers: 2 });
});

test("readCrewReply: a reply for another room is refused as offline", () => {
  const r = readCrewReply(reply(), "1OwxWzqXyLbJQ");
  assert.deepEqual([r.ok, r.reason], [false, "offline"]);
});

test("readCrewReply: error envelopes keep their reason; unknown reasons become offline", () => {
  for (const reason of ["budget", "credits", "rate", "no-key", "auth", "upstream", "bad-id"]) {
    const r = readCrewReply(failure(reason), ID);
    assert.deepEqual([r.ok, r.reason], [false, reason]);
    assert.equal(typeof r.message, "string");
  }
  assert.equal(readCrewReply(failure("__proto__"), ID).reason, "offline");
  assert.equal(readCrewReply({ success: false }, ID).reason, "offline");
});

test("readCrewReply: junk never throws and reads as offline", () => {
  const junk = [null, undefined, "ok", 42, [], {}, { success: "yes" }, { success: true },
                { success: true, data: null }, { success: true, data: { id: ID, state: "live" } },
                { success: true, data: { id: ID, state: "gone", crew: [] } }];
  for (const body of junk) {
    const r = readCrewReply(body, ID);
    assert.deepEqual([r.ok, r.reason], [false, "offline"], JSON.stringify(body));
  }
  assert.equal(readCrewReply(reply(), "not an id!").reason, "offline");
});

test("normalizePerson: drops bad ids, usernames and roles", () => {
  assert.equal(normalizePerson(person("12a", "ada", "host")), null);
  assert.equal(normalizePerson(person(12, "ada", "host")), null);
  assert.equal(normalizePerson(person("1", "ada lovelace", "host")), null);
  assert.equal(normalizePerson(person("1", "a".repeat(16), "host")), null);
  assert.equal(normalizePerson(person("1", "ada", "listener")), null);
  assert.equal(normalizePerson(null), null);
  assert.equal(normalizePerson("ada"), null);
  assert.equal(normalizePerson(person("1", "ada_99", "speaker")).username, "ada_99");
});

test("normalizePerson: avatars must be https on X's image hosts", () => {
  const bad = ["http://pbs.twimg.com/a_normal.jpg", "https://evil.com/a_normal.jpg",
               "https://pbs.twimg.com.evil.com/a.jpg", "javascript:alert(1)",
               "https://user:pw@pbs.twimg.com/a.jpg", "https://pbs.twimg.com:444/a.jpg", 7];
  for (const url of bad) {
    const p = normalizePerson(person("1", "ada", "host", { avatar: url, avatar_small: url }));
    assert.deepEqual([p.avatar, p.avatarSmall], ["", ""], String(url));
  }
  const ok = normalizePerson(person("1", "ada", "host", {
    avatar: "https://abs.twimg.com/sticky/default_profile_images/default_profile_200x200.png" }));
  assert.match(ok.avatar, /^https:\/\/abs\.twimg\.com\//);
});

test("normalizePerson: names are cleaned, clipped to 50 code points, and never empty", () => {
  const n = (name) => normalizePerson(person("1", "ada", "host", { name })).name;
  assert.equal(n("  Ada \n\t Lovelace  "), "Ada Lovelace");
  assert.equal(n("Evil\u202egnp.exe\u2066x\u2069"), "Evilgnp.exex");
  assert.equal(n("Zero\u0000Width\u0007"), "ZeroWidth");
  assert.equal([...n("😀".repeat(60))].length, 50);
  assert.equal(n("مرحبا بالعالم"), "مرحبا بالعالم");
  assert.equal(n("👩‍🚀 Ava ✨"), "👩‍🚀 Ava ✨");
  assert.equal(n(""), "@ada");
  assert.equal(n(null), "@ada");
  assert.equal(n("\u202e\u2066"), "@ada");
});

test("normalizePerson: verified is one of X's types; protected must be exactly true", () => {
  const p = (extra) => normalizePerson(person("1", "ada", "host", extra));
  assert.equal(p({ verified: "business" }).verified, "business");
  assert.equal(p({ verified: "gold" }).verified, "");
  assert.equal(p({ verified: true }).verified, "");
  assert.equal(p({ protected: true }).protected, true);
  assert.equal(p({ protected: "true" }).protected, false);
});

test("avatarAt swaps between every size and leaves other URLs alone", () => {
  const base = "https://pbs.twimg.com/profile_images/9/pic";
  for (const from of ["normal", "x96", "200x200", "400x400"]) {
    for (const to of ["normal", "x96", "200x200", "400x400"]) {
      assert.equal(avatarAt(`${base}_${from}.jpg`, to), `${base}_${to}.jpg`);
    }
  }
  assert.equal(avatarAt(`${base}_normal`, "x96"), `${base}_x96`);
  assert.equal(avatarAt(`${base}_bigger.png`, "x96"), `${base}_bigger.png`);
  assert.equal(avatarAt(`${base}_normal.jpg`, "huge"), `${base}_normal.jpg`);
  assert.equal(avatarAt("https://example.com/a_normal.jpg", "x96"), "");
  assert.equal(avatarAt("not a url", "x96"), "");
  assert.equal(avatarAt(undefined, "x96"), "");
});

test("links: profiles and Spaces only for valid names and ids", () => {
  assert.equal(profileUrl("ada_99"), "https://x.com/ada_99");
  assert.equal(profileUrl("../home"), null);
  assert.equal(spaceLink(ID), `https://x.com/i/spaces/${ID}`);
  assert.equal(spaceLink("https://x.com/i/spaces/1YqKDqWqdPLxV"), null);
  assert.equal(spaceLink("short"), null);
});

test("othersCount is never negative; initials handle emoji and combined letters", () => {
  assert.equal(othersCount(1204, { hosts: 3, speakers: 8 }), 1193);
  assert.equal(othersCount(4, { hosts: 3, speakers: 8 }), 0);
  assert.equal(othersCount(null, null), 0);
  assert.equal(initials("ada"), "A");
  assert.equal(initials("@bob"), "B");
  assert.equal(initials("👩‍🚀 Ava"), "👩‍🚀");
  assert.equal(initials("🇯🇵 Kenji"), "🇯🇵");
  assert.equal(initials("élan"), "É");
  assert.equal(initials(""), "?");
});

test("rosterSentence reads the crew out loud", () => {
  const d = readCrewReply(reply(), ID).data;
  assert.equal(rosterSentence(d), "Crew: host @ada, 2 co-hosts, 8 speakers, 1,193 others listening.");
  const small = readCrewReply(reply({ listeners: 3, counts: { hosts: 2, speakers: 1 },
    crew: [person("1", "ada", "host"), person("2", "bo", "cohost"), person("4", "di", "speaker")] }), ID).data;
  assert.equal(rosterSentence(small), "Crew: host @ada, 1 co-host, 1 speaker.");
  const empty = readCrewReply(reply({ crew: [], counts: { hosts: 0, speakers: 0 }, listeners: 1 }), ID).data;
  assert.equal(rosterSentence(empty), "Crew: nobody named on the mic, 1 other listening.");
  assert.equal(rosterSentence(readCrewReply(reply({ state: "ended" }), ID).data), "This Space has ended.");
});

test("stateFor maps every result to a screen", () => {
  const ok = (data, meta) => readCrewReply(reply(data, meta), ID);
  assert.equal(stateFor(ok()), "ready");
  assert.equal(stateFor(ok({ crew: [] })), "empty");
  assert.equal(stateFor(ok({}, { mode: "host-only" })), "hostonly");
  assert.equal(stateFor(ok({ state: "ended" })), "ended");
  assert.equal(stateFor(ok({ state: "scheduled" })), "scheduled");
  const cases = { budget: "resting", credits: "resting", rate: "busy", "no-key": "nokey",
                  offline: "offline", upstream: "offline", auth: "offline", "bad-id": "offline",
                  "bad-request": "offline" };
  for (const [reason, state] of Object.entries(cases)) {
    assert.equal(stateFor(readCrewReply(failure(reason), ID)), state, reason);
  }
  assert.equal(stateFor({ ok: false, reason: "cooling", retryAt: 1 }), "cooling");
  assert.equal(stateFor(null), "offline");
  assert.equal(stateFor({ ok: true }), "offline");
});

test("noteFor: fallback screens name the next move; cooling shows the wait", () => {
  assert.equal(noteFor("resting").lead, "openx");
  assert.equal(noteFor("nokey").lead, "openx");
  assert.deepEqual(noteFor("offline").actions, ["retry"]);
  assert.deepEqual(noteFor("ended").actions, ["next"]);
  assert.match(noteFor("cooling", { left: 95_000 }).body, /6 rooms every 10 minutes\. Try again in 1:35, or:/);
  assert.deepEqual(noteFor("cooling", { left: 0 }).actions, ["retry"]);
  assert.equal(noteFor("ready"), null);
});

test("screen words: meta line, skeleton size, and each person's spoken name", () => {
  const now = Date.parse("2026-09-24T12:00:00Z");
  assert.equal(metaLine({ state: "live", started_at: "2026-09-24T10:48:00Z", lang: "en", listeners: 1204 }, now),
               "● LIVE 1H12 · EN · 1,204 ABOARD");
  assert.equal(metaLine({ state: "ended", started_at: "", lang: "other", listeners: 0 }, now), "ENDED");
  assert.equal(metaLine({ state: "", started_at: "", lang: "", listeners: null }, now), "");
  assert.equal(skeletonCount({ listeners: 40, hosts: 1, speakers: 3 }), 4);
  assert.equal(skeletonCount({ listeners: 40, hosts: 0, speakers: 0 }), 1);
  assert.equal(skeletonCount({ listeners: 900, hosts: 5, speakers: 30 }), 12);
  assert.equal(skeletonCount({ listeners: null, hosts: 0, speakers: 0 }), 3);
  const p = normalizePerson(person("1", "ada", "cohost", { name: "Ada" }));
  assert.equal(personLabel(p), "Ada, @ada, Co-host. Opens their X profile.");
});

test("anchorBox centers the card on the radio, never wider than 420", () => {
  assert.deepEqual(anchorBox({ left: 100, width: 600 }), { x: 400, w: 420 });
  assert.deepEqual(anchorBox({ left: 0, width: 344 }), { x: 172, w: 320 });
  assert.equal(anchorBox(null), null);
  assert.equal(anchorBox({ left: 0, width: 0 }), null);
});

// A fake server and clock for the store.
function harness(bodyFor = () => reply()) {
  const clock = { t: 1_000_000 };
  const calls = [];
  const fetchJson = (url) => {
    calls.push(url);
    const id = decodeURIComponent(url.split("id=")[1]);
    return Promise.resolve(bodyFor(id));
  };
  const store = createCrewStore({ fetchJson, now: () => clock.t });
  return { clock, calls, store };
}
const idN = (n) => `1Room${String(n).padStart(8, "0")}`;
const echo = (id) => reply({ id });

test("store: a memo hit within two minutes makes no second call", async () => {
  const { clock, calls, store } = harness();
  const first = await store.get(ID);
  clock.t += 119_000;
  const again = await store.get(ID);
  assert.equal(calls.length, 1);
  assert.equal(calls[0], `/api/crew?id=${ID}`);
  assert.equal(again.data, first.data);
  clock.t += 2_000;
  await store.get(ID);
  assert.equal(calls.length, 2);
});

test("store: concurrent gets share one request", async () => {
  const { calls, store } = harness();
  const [a, b] = await Promise.all([store.get(ID), store.get(ID)]);
  assert.equal(calls.length, 1);
  assert.equal(a, b);
});

test("store: the 7th room within 10 minutes cools down until the oldest scan ages out", async () => {
  const { clock, calls, store } = harness(echo);
  const start = clock.t;
  for (let n = 1; n <= 6; n++) {
    assert.equal((await store.get(idN(n))).ok, true);
    clock.t += 1_000;
  }
  const cool = await store.get(idN(7));
  assert.deepEqual([cool.ok, cool.reason, cool.retryAt], [false, "cooling", start + 600_000]);
  assert.equal(calls.length, 6);
  clock.t += 200_000;
  assert.equal((await store.get(idN(2))).ok, true, "a room already scanned is still allowed");
  clock.t = start + 600_000;
  assert.equal((await store.get(idN(7))).ok, true);
  assert.equal(calls.length, 8);
});

test("store: failed scans aren't memoized and don't use up the allowance", async () => {
  let fail = true;
  const clock = { t: 0 };
  let calls = 0;
  const store = createCrewStore({
    fetchJson: () => { calls += 1; return fail ? Promise.reject(new Error("down")) : Promise.resolve(reply()); },
    now: () => clock.t, maxRooms: 1,
  });
  const r = await store.get(ID);
  assert.deepEqual([r.ok, r.reason], [false, "offline"]);
  assert.equal(store.peek(ID), null);
  fail = false;
  assert.equal((await store.get(ID)).ok, true);
  assert.equal(calls, 2);
});

test("store: unparseable JSON and a throwing fetch both read as offline", async () => {
  const bad = createCrewStore({ fetchJson: () => Promise.reject(new SyntaxError("Unexpected token <")) });
  assert.equal((await bad.get(ID)).reason, "offline");
  const throws = createCrewStore({ fetchJson: () => { throw new Error("no fetch"); } });
  assert.equal((await throws.get(ID)).reason, "offline");
  assert.equal((await throws.get("bad id")).ok, false);
});

test("store: peek quotes a roster for ten minutes, then forgets it", async () => {
  const { clock, store } = harness();
  await store.get(ID);
  assert.equal(store.peek(ID).host.username, "ada");
  assert.equal(store.peek(ID, clock.t + 600_000).host.username, "ada");
  assert.equal(store.peek(ID, clock.t + 600_001), null);
  assert.equal(store.peek("1OwxWzqXyLbJQ"), null);
});

test("head and footer words: kicker pill, status line, who leads the footer", () => {
  assert.deepEqual(crew.kickerWords("CH 03 · 96.3 FM", "onair"),
                   { text: "CREW MANIFEST · CH 03 · 96.3 FM", pill: "ON AIR", pillKind: "onair" });
  assert.deepEqual(crew.kickerWords("", "lined"), { text: "CREW MANIFEST", pill: "LINED UP", pillKind: "lined" });
  assert.equal(crew.kickerWords("x", "bogus").pill, "");
  const d = readCrewReply(reply(), ID, 0).data;
  assert.deepEqual(crew.statusWords("ready", d, 30_000),
                   { shown: "11 ON DECK · SCANNED JUST NOW", spoken: rosterSentence(d) });
  assert.equal(crew.statusWords("ready", d, 180_000).shown, "11 ON DECK · SCANNED 3 MIN AGO");
  assert.equal(crew.statusWords("resting", null).shown, "CREW SCANNER RESTING");
  assert.equal(crew.statusWords("loading", null).shown, "SCANNING CREW…");
  for (const s of ["resting", "nokey", "cooling", "ended"]) assert.equal(crew.footLead(s), "openx", s);
  for (const s of ["ready", "busy", "offline", "loading"]) assert.equal(crew.footLead(s), "listen", s);
});

test("the footer's listen link only ever points at X", () => {
  assert.equal(crew.listenHref(`https://x.com/i/spaces/${ID}`, ID), `https://x.com/i/spaces/${ID}`);
  assert.equal(crew.listenHref("javascript:alert(1)", ID), `https://x.com/i/spaces/${ID}`);
  assert.equal(crew.listenHref("https://x.com.evil.io/", ID), `https://x.com/i/spaces/${ID}`);
  assert.equal(crew.listenHref(undefined, "bad"), null);
});

test("a deck room's head before the scan, and the dial's title kept when X drops it", () => {
  assert.deepEqual(crew.roomInfo({ title: " Night\nowls ", listeners: null, source: "yours", started_at: "", lang: "" }),
                   { title: "Night owls", state: "", started_at: "", lang: "", listeners: null });
  assert.equal(crew.roomInfo({ source: "x-api", listeners: 4 }).state, "live");
  const untitled = readCrewReply(reply({ state: "ended", title: "" }), ID).data;
  assert.equal(crew.headInfo({ title: "Gone room" }, untitled).title, "Gone room");
  const titled = readCrewReply(reply(), ID).data;
  assert.equal(crew.headInfo({ title: "Old words" }, titled), titled);
});

test("clock words: m:ss countdowns, roster age, staleness after two minutes", () => {
  assert.equal(crew.mmss(60_000), "1:00");
  assert.equal(crew.mmss(1), "0:01");
  assert.equal(crew.mmss(-5), "0:00");
  assert.equal(crew.ageWords(0, 59_999), "JUST NOW");
  assert.equal(crew.ageWords(0, 125_000), "2 MIN AGO");
  assert.equal(crew.isStale(0, 120_000), false);
  assert.equal(crew.isStale(0, 120_001), true);
});

test("store: the room's ticket from /api/tune rides along; anything else is dropped", async () => {
  let calls = [];
  const store = createCrewStore({ fetchJson: (url) => { calls = [...calls, url]; return Promise.resolve(reply()); } });
  await store.get(ID, "0123456789abcdef");
  assert.deepEqual(calls, [`/api/crew?id=${ID}&t=0123456789abcdef`]);
  for (const junk of [undefined, "", "<script>", "0123456789ABCDEF", "0123456789abcdef0", 42]) {
    assert.equal(crew.crewPath(ID, junk), `/api/crew?id=${ID}`, String(junk));
  }
});
