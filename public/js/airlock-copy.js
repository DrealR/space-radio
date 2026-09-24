// Every word the launch shows, decided from the air state alone. Pure; tested in
// tests/airlock.test.mjs. Rule: nothing says ON AIR or LISTENING until the listener
// says they hear the room, and every screen names the next key to press.
import { X_START, X_START_ANON, isHailing, isHere, isLinedUp } from "./airlock.js";

const ARROWS = { right: "→", left: "←", over: "↗", tab: "↗", app: "↗" };
const STALE = "If an old X window is still open, close it so two rooms don't play.";
const pad = (n) => String(n).padStart(2, "0");

// ---- the big button ------------------------------------------------------------
// Pop-ups once blocked this session: a new window would only be blocked again.
const docks = (ctx) => ctx.dockable && !ctx.popupsBlocked;

function jumpDesk(air, ctx) {
  const opens = air.handle === "kept" ? "loads this room in your X window"
    : docks(ctx) ? "X opens beside the radio" : "X opens in a new tab";
  if (air.phase !== "onair") return { text: "PUSH TO JUMP", sub: opens, mode: "intercept" };
  const keeps = air.handle === "cut" || air.handle === "none";
  const sub = keeps ? "then close the old X tab"
    : ctx.playingCh ? `CH ${pad(ctx.playingCh)} plays till you jump` : "your room plays till you jump";
  return { text: "PUSH TO JUMP", sub, mode: "intercept" };
}

function airlockDesk(air, ctx) {
  if (isHailing(air, ctx.now)) {
    const where = air.side === "tab" || !docks(ctx) ? "opening X in a new tab" : "opening X beside the radio";
    return { text: "HAILING…", sub: where, mode: "intercept" };
  }
  return { text: `STEP 2 IN X ${ARROWS[air.side] || "↗"}`, sub: `press ▶ ${X_START} there`, mode: "intercept" };
}

function deskWords(air, ctx) {
  const mode = "intercept";
  if (air.phase === "blocked") return { text: "OPEN IN X ↗", sub: "pop-up blocked · this link always works", mode: "newtab" };
  if (isLinedUp(air, ctx.currentId)) return jumpDesk(air, ctx);
  if (air.phase === "airlock") return airlockDesk(air, ctx);
  if (air.phase === "onair") {
    const tab = air.handle === "cut" || air.handle === "none";
    return { text: "LISTENING", sub: tab ? "the sound plays in your X tab" : "push to bring X forward", mode };
  }
  // Lost: X may still be playing. Reopening is for silence, or two rooms play at once.
  if (air.phase === "lost") {
    return { text: "PUSH TO REOPEN", sub: air.wasOnAir ? "only if the sound stopped" : "only if you hear nothing", mode };
  }
  return { text: "PUSH TO LISTEN", sub: docks(ctx) ? "X opens beside the radio" : "X opens in a new tab", mode };
}

// A press that would open a window becomes a plain new-tab link once pop-ups were blocked.
// A room already open in X keeps its press, so it is brought forward, never opened twice.
function deskPtt(air, ctx) {
  const words = deskWords(air, ctx);
  const alreadyOpen = isHere(air, ctx.currentId) && (air.phase === "airlock" || air.phase === "onair");
  return ctx.popupsBlocked && words.mode === "intercept" && !alreadyOpen ? { ...words, mode: "newtab" } : words;
}

function phonePtt(air, ctx) {
  const mode = "link";
  if (isLinedUp(air, ctx.currentId)) return { text: "PUSH TO JUMP", sub: "opens this room in X", mode };
  if (air.phase === "away") return { text: "OPENING X…", sub: `tap ▶ ${X_START} there`, mode };
  if (air.phase === "back") return { text: "BACK TO X", sub: "reopens the room in X", mode };
  if (air.phase === "onair") return { text: "YOU'RE IN", sub: "tap to go back to X", mode };
  const sub = ctx.standalone ? `opens a browser sheet · tap ${X_START}` : `opens X · then tap ▶ ${X_START}`;
  return { text: "PUSH TO JOIN", sub, mode };
}

function pttCopy(air, ctx) {
  if (!ctx.hasRoom) return { text: "NO SIGNAL", sub: "pick another band", mode: "off" };
  if (ctx.ended) return { text: "ROOM ENDED", sub: "turn the knob for a live one", mode: "off" };
  return ctx.kind === "phone" ? phonePtt(air, ctx) : deskPtt(air, ctx);
}

// ---- the screen, the lamp, the rail ----------------------------------------------
function airlockLcd(air, ctx) {
  if (isHailing(air, ctx.now)) return `HAILING ${ctx.freq} FM ···`;
  if (air.asked) return "HEARING THEM? ANSWER BELOW ↓";
  if (air.quietShown) return "NO SOUND? LOOK FOR ▶ IN X";
  return "PRESS ▶ START LISTENING IN X";
}

const PHONE_LCD = { away: "HANDING OFF TO X…", back: "BACK ON THE BRIDGE", onair: "● ON AIR IN X" };
const stoppedHere = (air) => air.phase === "back" && air.inTab;

function lcdCopy(air, ctx) {
  if (!ctx.hasRoom) return null;
  if (ctx.ended) return "THIS SHIP HAS LEFT";
  if (air.phase === "blocked") return "POP-UP BLOCKED · LINK BELOW ↓";
  if (isLinedUp(air, ctx.currentId)) return "NEXT SHIP LINED UP · PUSH";
  if (ctx.kind === "phone") return stoppedHere(air) ? "SOUND STOPPED · OPEN AGAIN" : PHONE_LCD[air.phase] || null;
  if (air.phase === "airlock") return airlockLcd(air, ctx);
  if (air.phase === "onair") return "● ON AIR · LIVE · NO OLD LIGHT";
  if (air.phase === "lost") return air.wasOnAir ? "LOST TRACK OF THE X WINDOW" : "LOST TRACK OF X · HEARING IT?";
  return null;
}

// Stand by whenever X may be playing but the listener hasn't said so (lost included).
function lampCopy(air) {
  if (air.phase === "onair") return "onair";
  if (stoppedHere(air)) return "off";
  return ["airlock", "away", "back", "lost"].includes(air.phase) ? "stby" : "off";
}

function railCopy(air, ctx) {
  if (air.phase === "onair") return ["on", "on", "on"];
  if (stoppedHere(air)) return ["on", "off", "off"];
  if (air.phase === "airlock" || air.phase === "away" || air.phase === "back") return ["on", "blink", "off"];
  if (air.phase === "lost") return air.wasOnAir ? ["on", "on", "blink"] : ["on", "off", "off"];
  return ctx.hasRoom && !ctx.ended ? ["blink", "off", "off"] : ["off", "off", "off"];
}

// ---- the airlock panel -------------------------------------------------------------
const HEARD = { id: "heard", text: "✓ I HEAR IT", primary: true };
const NO_SOUND = { id: "nosound", text: "NO SOUND?" };

function windowChip(air) {
  if (air.handle === "cut") return { id: "opentab", text: "OPEN IN A TAB ↗", link: "tab" };
  if (air.handle === "none") return { id: "openagain", text: "OPEN AGAIN ↗", link: "tab" };
  return { id: "forward", text: "BRING X FORWARD" };
}

function kicker(air, plain) {
  return air.note === "steered" ? "NEW ROOM LOADED · PRESS ▶ AGAIN" : plain;
}

function fullPanel(air) {
  return {
    variant: "full", kicker: kicker(air, "STEP 2 OF 2 · IN THE X WINDOW"), pill: X_START,
    body: `X plays the sound, and it needs one click from you in every room. Logged out? It says “${X_START_ANON}”.`,
    why: true, note: air.note === "stale" ? STALE : "", steps: [], chips: [HEARD, windowChip(air), NO_SOUND],
  };
}

function compactPanel(air) {
  return {
    variant: "compact", kicker: kicker(air, ""), pill: X_START, body: "in X, then", why: false,
    note: air.note === "stale" ? STALE : "", steps: [], chips: [HEARD, NO_SOUND],
  };
}

function deskHelp(air) {
  const steps = [
    { text: "Find the X window. It opened beside the radio (or as a new tab).", chip: windowChip(air) },
    { text: `Press X's ▶ ${X_START}. Logged out, it says ${X_START_ANON}.` },
    { text: "Look for a muted speaker on the X tab, and check your volume." },
    { text: "Rooms go quiet between speakers. Give it 20 seconds." },
    { text: `Signed in to X just now? The room reloads: press ${X_START} again.` },
    { text: "The room may have ended.", chip: { id: "next", text: "NEXT SHIP →" } },
  ];
  return {
    variant: "help", kicker: "NO SOUND? CHECK IN ORDER", pill: "", body: "", why: false, note: "", steps,
    chips: [{ id: "heard", text: "✓ I HEAR IT NOW", primary: true }, { id: "reopen", text: "REOPEN THIS ROOM" }],
  };
}

function phoneHelp(ctx) {
  const lines = [
    ctx.standalone ? "" : "X opened a web page, not the app? Long-press PUSH TO JOIN and choose Open in X. iPhone remembers if you once picked Safari.",
    `No X app? It plays in the browser too: tap ${X_START} there. Coming back here stops it.`,
    ctx.standalone ? `From the home-screen radio, links open in a browser sheet. Tap ${X_START} there, or open the radio in Safari.` : "",
  ].filter(Boolean);
  return {
    variant: "phone-help", kicker: "IF X DIDN'T PLAY", pill: "", body: "", why: false, note: "",
    steps: lines.map((text) => ({ text })), force: Boolean(ctx.android),
    chips: [{ id: "heard", text: "✓ I'M IN", primary: true }, { id: "openagain", text: "OPEN AGAIN ↗", link: "same" }],
  };
}

// Lost, straight from the airlock, is often the moment X started playing (signing in or
// Start listening can cut the radio's link), so the first offer is I HEAR IT, not a reopen.
function lostPanel(air) {
  const onAir = air.wasOnAir;
  return {
    variant: "lost", kicker: "LOST TRACK OF X", pill: "", why: false, note: "", steps: [],
    body: onAir ? "The X window closed, or X cut the radio's link to it. The radio can't tell which."
      : "The X window closed, or X cut the radio's link to it (signing in can do that). Hearing the room? Say so. Hearing nothing? Push to reopen.",
    chips: onAir ? [{ id: "heard", text: "STILL HEAR IT" }, { id: "stopped", text: "IT STOPPED" }]
      : [HEARD, { id: "stopped", text: "START OVER" }],
  };
}

// X played in this very tab (no X app, or a home-screen radio): coming back stopped it.
const BACK_STOPPED = Object.freeze({
  variant: "back-stopped", kicker: "THE SOUND STOPPED", pill: "", why: false, note: "", steps: [],
  body: "X played in this tab, so coming back here stopped it. To keep listening, stay on X's page, or get the X app.",
  chips: [{ id: "openagain", text: "OPEN AGAIN ↗", link: "same", primary: true }, { id: "next", text: "NEXT SHIP →" }],
});

function backPanel(air, ctx) {
  if (air.inTab) return BACK_STOPPED;
  if (air.help) return phoneHelp(ctx);
  return {
    variant: "back", kicker: "BACK ON THE BRIDGE", pill: "", why: false, note: "", steps: [],
    body: `Did the room play? In X, tap ▶ ${X_START}. Talking needs the X app and an account.`,
    chips: [{ id: "heard", text: "✓ I'M IN", primary: true }, { id: "nosound", text: "HELP" }],
  };
}

const PANELS = {
  blocked: (air) => ({
    variant: "blocked", kicker: "X'S WINDOW WAS BLOCKED", pill: "", why: false, steps: [], chips: [],
    note: air.note === "stale" ? STALE : "",
    body: "Your browser stopped the pop-up. The big button now opens the room in a new tab. To dock X beside the radio next time, allow pop-ups for this site (icon at the right end of the address bar).",
  }),
  lost: lostPanel,
  back: backPanel,
  // Coming back (asked) changes the screen line only: the card under the pointer must not move.
  airlock: (air, ctx) => {
    if (air.help) return deskHelp(air);
    return ctx.confirms >= 2 ? compactPanel(air) : fullPanel(air);
  },
};

function panelCopy(air, ctx) {
  const make = PANELS[air.phase];
  return make ? make(air, ctx) : null;
}

/**
 * Everything the launch shows. ctx = { kind, dockable, standalone, android, hasRoom, ended,
 * now, confirms, freq, playingCh, currentId, popupsBlocked }.
 */
export function airCopy(air, ctx) {
  return {
    ptt: pttCopy(air, ctx),
    lcd: lcdCopy(air, ctx),
    lamp: lampCopy(air),
    rail: railCopy(air, ctx),
    panel: panelCopy(air, ctx),
    here: isHere(air, ctx.currentId),
    linedUp: ctx.hasRoom && isLinedUp(air, ctx.currentId),
  };
}
