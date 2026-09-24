// node --test tests/*.mjs — the two-key launch: honest status, never mutated.
import test from "node:test";
import assert from "node:assert/strict";
import {
  AIR_EVENTS, AIR_IDLE, ASK_MS, HAIL_MS, PHASES, QUIET_MS, X_START, X_START_ANON,
  airNext, canHear, isHailing, isLinedUp,
} from "../public/js/airlock.js";
import { airCopy } from "../public/js/airlock-copy.js";

const ROOM = "1YqKDqWqdPLxV";
const OTHER = "1OwxWzqXyLbJQ";
const T = 1_000_000;

function deepFreeze(o) {
  Object.values(o).forEach((v) => v && typeof v === "object" && deepFreeze(v));
  return Object.freeze(o);
}
const air = (patch) => deepFreeze({ ...AIR_IDLE, roomId: ROOM, since: T, ...patch });
const ctx = (patch = {}) => ({
  kind: "desktop", dockable: true, standalone: false, android: false, hasRoom: true, ended: false,
  now: T + 5000, confirms: 0, freq: "96.3", playingCh: 3, currentId: ROOM, ...patch,
});

const EVENT_SAMPLES = {
  opened: { type: "opened", roomId: ROOM, side: "right", handle: "unknown", now: T },
  blocked: { type: "blocked", roomId: ROOM, now: T },
  heard: { type: "heard", now: T + 9000 },
  noSound: { type: "noSound" },
  dismiss: { type: "dismiss" },
  returned: { type: "returned", now: T + ASK_MS + 1 },
  quiet: { type: "quiet", now: T + QUIET_MS + 1 },
  handleKept: { type: "handleKept" },
  handleCut: { type: "handleCut" },
  windowClosed: { type: "windowClosed" },
  stopped: { type: "stopped" },
  away: { type: "away", roomId: ROOM, now: T },
  reset: { type: "reset" },
};

test("every event from every phase returns a new frozen object and never edits the input", () => {
  assert.deepEqual([...AIR_EVENTS].sort(), Object.keys(EVENT_SAMPLES).sort());
  for (const phase of PHASES) {
    for (const event of Object.values(EVENT_SAMPLES)) {
      const before = air({ phase, handle: "unknown" });
      const copy = JSON.stringify(before);
      const next = airNext(before, event);
      assert.notEqual(next, before, `${phase} + ${event.type} must be a new object`);
      assert.ok(Object.isFrozen(next));
      assert.equal(JSON.stringify(before), copy);
      assert.ok(PHASES.includes(next.phase), `${phase} + ${event.type} -> ${next.phase}`);
    }
  }
});

test("opened starts the airlock and resets the questions", () => {
  const next = airNext(air({ phase: "onair", asked: true, help: true, quietShown: true, wasOnAir: true }),
    EVENT_SAMPLES.opened);
  assert.equal(next.phase, "airlock");
  assert.equal(next.side, "right");
  assert.equal(next.handle, "unknown");
  assert.deepEqual([next.asked, next.quietShown, next.help, next.wasOnAir], [false, false, false, false]);
  assert.equal(airNext(AIR_IDLE, { ...EVENT_SAMPLES.opened, note: "steered" }).note, "steered");
  assert.equal(airNext(AIR_IDLE, { ...EVENT_SAMPLES.opened, note: "<b>" }).note, "");
});

test("heard only counts from airlock, lost or back; idle and blocked ignore it", () => {
  for (const phase of ["airlock", "lost", "back"]) {
    assert.equal(airNext(air({ phase, help: true }), EVENT_SAMPLES.heard).phase, "onair");
    assert.equal(airNext(air({ phase, help: true }), EVENT_SAMPLES.heard).help, false);
  }
  for (const phase of ["idle", "blocked", "away", "onair"]) {
    assert.equal(airNext(air({ phase }), EVENT_SAMPLES.heard).phase, phase);
  }
});

test("returned asks once after a while in the airlock; away comes back", () => {
  const early = airNext(air({ phase: "airlock" }), { type: "returned", now: T + ASK_MS - 1 });
  assert.equal(early.asked, false);
  const asked = airNext(air({ phase: "airlock" }), EVENT_SAMPLES.returned);
  assert.equal(asked.asked, true);
  const back = airNext(air({ phase: "away" }), { type: "returned", now: T + 50 });
  assert.equal(back.phase, "back");
  assert.equal(airNext(air({ phase: "onair" }), EVENT_SAMPLES.returned).phase, "onair");
});

test("quiet hint only after 20 s in the airlock", () => {
  assert.equal(airNext(air({ phase: "airlock" }), { type: "quiet", now: T + QUIET_MS - 1 }).quietShown, false);
  assert.equal(airNext(air({ phase: "airlock" }), EVENT_SAMPLES.quiet).quietShown, true);
  assert.equal(airNext(air({ phase: "onair" }), EVENT_SAMPLES.quiet).quietShown, false);
});

test("handles: kept only from unknown; a cut never changes the phase", () => {
  assert.equal(airNext(air({ phase: "airlock", handle: "unknown" }), { type: "handleKept" }).handle, "kept");
  assert.equal(airNext(air({ phase: "airlock", handle: "none" }), { type: "handleKept" }).handle, "none");
  const cut = airNext(air({ phase: "onair", handle: "kept" }), { type: "handleCut" });
  assert.deepEqual([cut.phase, cut.handle], ["onair", "cut"]);
});

test("a closed window is lost, remembering whether it was on air", () => {
  const fromAirlock = airNext(air({ phase: "airlock", handle: "kept" }), { type: "windowClosed" });
  assert.deepEqual([fromAirlock.phase, fromAirlock.wasOnAir, fromAirlock.handle], ["lost", false, "none"]);
  assert.equal(airNext(air({ phase: "onair" }), { type: "windowClosed" }).wasOnAir, true);
  assert.equal(airNext(air({ phase: "idle" }), { type: "windowClosed" }).phase, "idle");
});

test("stopped and reset go idle; away is the phone's trip to X", () => {
  assert.deepEqual(airNext(air({ phase: "onair" }), { type: "stopped" }), AIR_IDLE);
  assert.deepEqual(airNext(air({ phase: "lost" }), { type: "reset" }), AIR_IDLE);
  const away = airNext(air({ phase: "onair" }), EVENT_SAMPLES.away);
  assert.deepEqual([away.phase, away.side, away.roomId], ["away", "app", ROOM]);
});

test("hailing is the first 1.2 s of the airlock; lined up means the needle moved on", () => {
  assert.equal(isHailing(air({ phase: "airlock" }), T + HAIL_MS - 1), true);
  assert.equal(isHailing(air({ phase: "airlock" }), T + HAIL_MS), false);
  assert.equal(isLinedUp(air({ phase: "onair" }), OTHER), true);
  assert.equal(isLinedUp(air({ phase: "onair" }), ROOM), false);
  assert.equal(isLinedUp(air({ phase: "idle" }), OTHER), false);
});

// Every state the copy can meet, both device kinds.
function allCases() {
  const cases = [];
  const kinds = [{ kind: "desktop", dockable: true }, { kind: "desktop", dockable: false }, { kind: "phone", dockable: false }];
  for (const k of kinds) {
    for (const phase of PHASES) {
      for (const handle of ["unknown", "kept", "cut", "none"]) {
        for (const side of ["right", "left", "over", "tab", "app"]) {
          for (const flags of [{}, { asked: true }, { quietShown: true }, { help: true }, { wasOnAir: true }, { note: "stale" },
            { note: "steered" }, { inTab: true }]) {
            for (const c of [{}, { currentId: OTHER }, { currentId: OTHER, playingCh: null }, { hasRoom: false, currentId: null },
              { ended: true }, { now: T + 100 }, { confirms: 3 }, { standalone: true }, { android: true }, { popupsBlocked: true }]) {
              cases.push([air({ phase, handle, side, ...flags }), ctx({ ...k, ...c })]);
            }
          }
        }
      }
    }
  }
  return cases;
}

function strings(value, out = []) {
  if (typeof value === "string") out.push(value);
  else if (value && typeof value === "object") Object.values(value).forEach((v) => strings(v, out));
  return out;
}

test("nothing says ON AIR or LISTENING, or lights the lamp, unless the phase is onair", () => {
  for (const [a, c] of allCases()) {
    const copy = airCopy(a, c);
    if (a.phase === "onair") continue;
    // X's own button name ("START LISTENING") is an instruction, not a status.
    const words = strings(copy).map((s) => s.replace(/start listening/gi, ""));
    for (const s of words) assert.doesNotMatch(s, /ON AIR|LISTENING/, `${a.phase}: "${s}"`);
    assert.notEqual(copy.lamp, "onair");
    assert.notDeepEqual(copy.rail, ["on", "on", "on"]);
  }
});

test("every button and screen line fits its hardware", () => {
  for (const [a, c] of allCases()) {
    const { ptt, lcd } = airCopy(a, c);
    assert.ok(ptt.text.length <= 14, `ptt.text "${ptt.text}"`);
    assert.ok(ptt.sub.length <= 46, `ptt.sub "${ptt.sub}"`);
    assert.ok(lcd === null || lcd.length <= 32, `lcd "${lcd}"`);
    assert.ok(["intercept", "newtab", "link", "off"].includes(ptt.mode));
    if (c.kind === "phone" && ptt.mode !== "off") assert.equal(ptt.mode, "link");
  }
});

test("desktop copy table", () => {
  const idle = airCopy(AIR_IDLE, ctx());
  assert.deepEqual([idle.ptt.text, idle.ptt.sub, idle.lamp, idle.lcd], ["PUSH TO LISTEN", "X opens beside the radio", "off", null]);
  assert.deepEqual(idle.rail, ["blink", "off", "off"]);
  assert.equal(airCopy(AIR_IDLE, ctx({ dockable: false })).ptt.sub, "X opens in a new tab");
  assert.equal(airCopy(AIR_IDLE, ctx({ hasRoom: false })).ptt.text, "NO SIGNAL");
  assert.equal(airCopy(AIR_IDLE, ctx({ ended: true })).lcd, "THIS SHIP HAS LEFT");

  const hailing = airCopy(air({ phase: "airlock" }), ctx({ now: T + 10 }));
  assert.deepEqual([hailing.ptt.text, hailing.lcd, hailing.lamp], ["HAILING…", "HAILING 96.3 FM ···", "stby"]);
  const airlock = airCopy(air({ phase: "airlock", side: "left" }), ctx());
  assert.deepEqual([airlock.ptt.text, airlock.lcd], ["STEP 2 IN X ←", "PRESS ▶ START LISTENING IN X"]);
  assert.deepEqual(airlock.rail, ["on", "blink", "off"]);
  assert.equal(airCopy(air({ phase: "airlock", side: "tab" }), ctx()).ptt.text, "STEP 2 IN X ↗");
  assert.equal(airCopy(air({ phase: "airlock", asked: true }), ctx()).lcd, "HEARING THEM? ANSWER BELOW ↓");
  assert.equal(airCopy(air({ phase: "airlock", quietShown: true }), ctx()).lcd, "NO SOUND? LOOK FOR ▶ IN X");

  const onair = airCopy(air({ phase: "onair", handle: "kept" }), ctx());
  assert.deepEqual([onair.ptt.text, onair.ptt.sub, onair.lcd, onair.lamp],
    ["LISTENING", "push to bring X forward", "● ON AIR · LIVE · NO OLD LIGHT", "onair"]);
  const jump = airCopy(air({ phase: "onair", handle: "kept" }), ctx({ currentId: OTHER }));
  assert.deepEqual([jump.ptt.text, jump.ptt.sub, jump.lcd], ["PUSH TO JUMP", "CH 03 plays till you jump", "NEXT SHIP LINED UP · PUSH"]);
  assert.equal(airCopy(air({ phase: "airlock", handle: "kept" }), ctx({ currentId: OTHER })).ptt.sub,
    "loads this room in your X window");

  const lost = airCopy(air({ phase: "lost" }), ctx());
  assert.deepEqual([lost.lcd, lost.ptt.text, lost.ptt.sub, lost.lamp],
    ["LOST TRACK OF X · HEARING IT?", "PUSH TO REOPEN", "only if you hear nothing", "stby"]);
  assert.equal(airCopy(air({ phase: "lost", wasOnAir: true }), ctx()).lamp, "stby");
  assert.equal(airCopy(air({ phase: "lost", wasOnAir: true }), ctx()).ptt.sub, "only if the sound stopped");
  const blocked = airCopy(air({ phase: "blocked" }), ctx());
  assert.deepEqual([blocked.ptt.text, blocked.ptt.mode, blocked.lcd], ["OPEN IN X ↗", "newtab", "POP-UP BLOCKED · LINK BELOW ↓"]);
});

test("phone copy table", () => {
  const phone = (a, c = {}) => airCopy(a, ctx({ kind: "phone", dockable: false, ...c }));
  assert.deepEqual([phone(AIR_IDLE).ptt.text, phone(AIR_IDLE).ptt.sub], ["PUSH TO JOIN", `opens X · then tap ▶ ${X_START}`]);
  assert.match(phone(AIR_IDLE, { standalone: true }).ptt.sub, /browser sheet/);
  assert.equal(phone(air({ phase: "away" })).lcd, "HANDING OFF TO X…");
  assert.equal(phone(air({ phase: "back" })).ptt.text, "BACK TO X");
  assert.equal(phone(air({ phase: "onair" })).lcd, "● ON AIR IN X");
  assert.equal(phone(air({ phase: "onair" }), { currentId: OTHER }).ptt.sub, "opens this room in X");
});

test("airlock panel variants and chips", () => {
  const ids = (p) => p.chips.map((c) => c.id);
  assert.equal(airCopy(AIR_IDLE, ctx()).panel, null);
  assert.equal(airCopy(air({ phase: "onair" }), ctx()).panel, null);
  const full = airCopy(air({ phase: "airlock", handle: "unknown" }), ctx()).panel;
  assert.equal(full.variant, "full");
  assert.deepEqual(ids(full), ["heard", "forward", "nosound"]);
  assert.ok(full.body.includes(X_START_ANON));
  assert.equal(full.chips[0].primary, true);
  assert.deepEqual(ids(airCopy(air({ phase: "airlock", handle: "cut" }), ctx()).panel), ["heard", "opentab", "nosound"]);
  assert.equal(airCopy(air({ phase: "airlock" }), ctx({ confirms: 2 })).panel.variant, "compact");
  const help = airCopy(air({ phase: "airlock", help: true }), ctx()).panel;
  assert.equal(help.steps.length, 6);
  assert.deepEqual(ids(help), ["heard", "reopen"]);
  assert.equal(airCopy(air({ phase: "airlock", note: "steered" }), ctx()).panel.kicker, "NEW ROOM LOADED · PRESS ▶ AGAIN");
  assert.match(airCopy(air({ phase: "airlock", note: "stale" }), ctx()).panel.note, /old X window/);
  assert.deepEqual(ids(airCopy(air({ phase: "lost", wasOnAir: true }), ctx()).panel), ["heard", "stopped"]);
  const lostPanel = airCopy(air({ phase: "lost" }), ctx()).panel;
  assert.deepEqual(ids(lostPanel), ["heard", "stopped"]);
  assert.equal(lostPanel.chips[0].primary, true);
  assert.equal(airCopy(air({ phase: "blocked" }), ctx()).panel.variant, "blocked");
  const back = airCopy(air({ phase: "back" }), ctx({ kind: "phone" })).panel;
  assert.deepEqual(ids(back), ["heard", "nosound"]);
  const phoneHelp = airCopy(air({ phase: "back", help: true }), ctx({ kind: "phone", android: true })).panel;
  assert.equal(phoneHelp.variant, "phone-help");
  assert.equal(phoneHelp.force, true);
  assert.equal(phoneHelp.steps.length, 2);
  assert.equal(airCopy(air({ phase: "back", help: true }), ctx({ kind: "phone", standalone: true })).panel.steps.length, 2);
});

test("coming back never moves the card under the pointer: only the screen line asks", () => {
  for (const confirms of [0, 3]) {
    const quiet = airCopy(air({ phase: "airlock" }), ctx({ confirms }));
    const asked = airCopy(air({ phase: "airlock", asked: true }), ctx({ confirms }));
    assert.deepEqual(asked.panel, quiet.panel);
    assert.equal(asked.panel.variant, confirms ? "compact" : "full");
    assert.equal(asked.lcd, "HEARING THEM? ANSWER BELOW ↓");
  }
});

test("a blocked pop-up keeps what the radio knew, and later presses skip the wasted window", () => {
  const blocked = airNext(air({ phase: "onair", roomId: OTHER }), { type: "blocked", roomId: ROOM, now: T });
  assert.deepEqual([blocked.phase, blocked.wasOnAir, blocked.note], ["blocked", true, "stale"]);
  assert.equal(airNext(blocked, { type: "blocked", roomId: OTHER, now: T }).note, "stale");
  assert.equal(airNext(AIR_IDLE, { type: "blocked", roomId: ROOM, now: T }).note, "");
  assert.match(airCopy(blocked, ctx()).panel.note, /old X window/);

  const blockedCtx = ctx({ popupsBlocked: true });
  const idle = airCopy(AIR_IDLE, blockedCtx).ptt;
  assert.deepEqual([idle.mode, idle.sub], ["newtab", "X opens in a new tab"]);
  const jump = airCopy(air({ phase: "onair", handle: "none" }), ctx({ popupsBlocked: true, currentId: OTHER })).ptt;
  assert.deepEqual([jump.text, jump.mode], ["PUSH TO JUMP", "newtab"]);
  // The room already open in X keeps its press: brought forward, never opened twice.
  assert.equal(airCopy(air({ phase: "onair", handle: "none" }), blockedCtx).ptt.mode, "intercept");
  assert.equal(airCopy(air({ phase: "airlock", handle: "none" }), blockedCtx).ptt.mode, "intercept");
});

test("phone: X played in this tab, so coming back stopped it and I'M IN can't claim ON AIR", () => {
  const back = airNext(air({ phase: "away" }), { type: "returned", now: T + 50, inTab: true });
  assert.deepEqual([back.phase, back.inTab], ["back", true]);
  const late = airNext(air({ phase: "back" }), { type: "returned", now: T + 60, inTab: true });
  assert.equal(late.inTab, true);
  assert.equal(canHear(back), false);
  assert.equal(airNext(back, { type: "heard", now: T + 90 }).phase, "back");
  assert.equal(canHear(air({ phase: "back" })), true);

  const copy = airCopy(back, ctx({ kind: "phone", dockable: false }));
  assert.equal(copy.panel.variant, "back-stopped");
  assert.ok(!copy.panel.chips.some((c) => c.id === "heard"));
  assert.deepEqual([copy.lamp, copy.lcd], ["off", "SOUND STOPPED · OPEN AGAIN"]);
  assert.deepEqual(copy.rail, ["on", "off", "off"]);
  assert.deepEqual(airCopy(air({ phase: "back" }), ctx({ kind: "phone" })).panel.chips.map((c) => c.id), ["heard", "nosound"]);
  assert.equal(airNext(back, { type: "away", roomId: ROOM, now: T + 99 }).inTab, false);
});
