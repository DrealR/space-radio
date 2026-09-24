// Crew manifest, pure half: read X's roster reply again on this side, word the
// screens, and ration the scans (names cost the radio's owner money).
// No DOM, no network of its own. Tested in tests/crew.test.mjs through crew.js.

export const CREW_TTL_MS = 120_000;    // a roster counts as fresh for two minutes
export const CREW_KEEP_MS = 600_000;   // the radio may still quote it for ten
export const SCAN_WINDOW_MS = 600_000;
export const SCAN_MAX_ROOMS = 6;
export const RETRY_WAIT_MS = 60_000;   // after "X is busy"
export const MAX_CREW = 30;
export const EAR_DOTS = 48;

const SPACE_ID = /^[A-Za-z0-9]{8,13}$/;
const TICKET = /^[0-9a-f]{16}$/;
const USER_ID = /^[0-9]{1,20}$/;
const USERNAME = /^[A-Za-z0-9_]{1,15}$/;
const LANG = /^[A-Za-z]{2,8}(-[A-Za-z0-9]{1,8})?$/;
const STATES = new Set(["live", "ended", "scheduled"]);
const ROLES = new Set(["host", "cohost", "speaker"]);
const VERIFIED = new Set(["blue", "business", "government"]);
const AVATAR_HOSTS = new Set(["pbs.twimg.com", "abs.twimg.com"]);
const SIZES = new Set(["normal", "x96", "200x200", "400x400"]);
const SIZE_TAIL = /_(normal|x96|200x200|400x400)(\.[A-Za-z0-9]{2,5})?$/;
const REASONS = new Set(["bad-request", "bad-id", "no-key", "budget", "credits", "rate",
                         "auth", "offline", "upstream"]);
// Control characters and bidi overrides/isolates: a name must never repaint the text around it.
const UNSAFE = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g;
const MAX_COUNT = 10_000_000;
const UNTITLED = "Untitled room";

const ROLE_WORD = { host: "Host", cohost: "Co-host", speaker: "Speaker" };
export const ROLE_PILL = Object.freeze({ host: "HOST", cohost: "CO-HOST", speaker: "SPEAKER" });

/** Plain text from anything: whitespace collapsed, unsafe characters gone, clipped by code point. */
export function cleanText(value, max) {
  if (typeof value !== "string") return "";
  const flat = value.replace(/\s+/g, " ").replace(UNSAFE, "").replace(/ {2,}/g, " ").trim();
  return [...flat].slice(0, max).join("").trim();
}

const count = (v) => (typeof v === "number" && Number.isFinite(v)
  ? Math.min(MAX_COUNT, Math.max(0, Math.floor(v))) : 0);
export const formatCount = (n) => count(n).toLocaleString("en-US");

export const spaceLink = (id) => (typeof id === "string" && SPACE_ID.test(id)
  ? `https://x.com/i/spaces/${id}` : null);
export const profileUrl = (username) => (typeof username === "string" && USERNAME.test(username)
  ? `https://x.com/${username}` : null);

function safeAvatar(value) {
  if (typeof value !== "string" || value.length > 512) return "";
  try {
    const u = new URL(value);
    const ok = u.protocol === "https:" && AVATAR_HOSTS.has(u.hostname) && !u.port && !u.username && !u.password;
    return ok ? u.href : "";
  } catch {
    return "";
  }
}

/** Same picture at another size: X names them ..._normal.jpg, ..._x96.jpg, ..._200x200.jpg. */
export function avatarAt(url, size) {
  const safe = safeAvatar(url);
  if (!safe || !SIZES.has(size)) return safe;
  const u = new URL(safe);
  const path = u.pathname.replace(SIZE_TAIL, (_, _old, ext = "") => `_${size}${ext}`);
  return `${u.origin}${path}${u.search}`;
}

export function normalizePerson(raw) {
  if (!raw || typeof raw !== "object") return null;
  const { id, username, role } = raw;
  if (typeof id !== "string" || !USER_ID.test(id) || !ROLES.has(role)) return null;
  if (typeof username !== "string" || !USERNAME.test(username)) return null;
  return Object.freeze({
    id, role, username,
    name: cleanText(raw.name, 50) || `@${username}`,
    avatar: safeAvatar(raw.avatar),
    avatarSmall: safeAvatar(raw.avatar_small ?? raw.avatarSmall),
    verified: VERIFIED.has(raw.verified) ? raw.verified : "",
    protected: raw.protected === true,
    profileUrl: profileUrl(username),
  });
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

/** Host first (only the first one X names), then co-hosts, then speakers; unique, at most 30. */
function groupCrew(list) {
  const people = list.slice(0, 100).map(normalizePerson).filter(Boolean);
  const unique = people.filter((p, i) => people.findIndex((q) => q.id === p.id) === i);
  const host = unique.find((p) => p.role === "host") || null;
  const ordered = [host, ...unique.filter((p) => p.role === "cohost"),
                   ...unique.filter((p) => p.role === "speaker")].filter(Boolean).slice(0, MAX_CREW);
  return {
    host,
    cohosts: ordered.filter((p) => p.role === "cohost"),
    speakers: ordered.filter((p) => p.role === "speaker"),
  };
}

/** Server counts, but never fewer than the people the roster actually shows. */
function readCounts(raw, crew) {
  const shownHosts = (crew.host ? 1 : 0) + crew.cohosts.length;
  const box = raw && typeof raw === "object" ? raw : {};
  return { hosts: Math.max(count(box.hosts), shownHosts), speakers: Math.max(count(box.speakers), crew.speakers.length) };
}

const readTime = (v) => (typeof v === "string" && v.length <= 40 && Date.parse(v) ? v : "");
const readLang = (v) => (typeof v === "string" && LANG.test(v) ? v.toLowerCase() : "");

function readData(raw, requestedId, meta, now) {
  if (!raw || typeof raw !== "object" || !spaceLink(requestedId)) return null;
  if (raw.id !== requestedId || !STATES.has(raw.state) || !Array.isArray(raw.crew)) return null;
  const crew = raw.state === "live" ? groupCrew(raw.crew) : { host: null, cohosts: [], speakers: [] };
  const counts = readCounts(raw.counts, crew);
  const listeners = count(raw.listeners);
  return deepFreeze({
    id: requestedId, state: raw.state, title: cleanText(raw.title, 200) || UNTITLED,
    listeners, started_at: readTime(raw.started_at), lang: readLang(raw.lang),
    url: spaceLink(requestedId), ...crew, counts, others: othersCount(listeners, counts),
    mode: meta && meta.mode === "host-only" ? "host-only" : "full", at: now,
  });
}

function failure(reason, message) {
  return { ok: false, reason, message: cleanText(message, 200) || "The crew scan didn't come back." };
}

/** The server already checked all of this; the radio checks it again before showing a name. */
export function readCrewReply(body, requestedId, now = Date.now()) {
  if (!body || typeof body !== "object" || typeof body.success !== "boolean") return failure("offline");
  if (!body.success) {
    const reason = body.meta && REASONS.has(body.meta.reason) ? body.meta.reason : "offline";
    return failure(reason, body.error);
  }
  const data = readData(body.data, requestedId, body.meta, now);
  return data ? { ok: true, data } : failure("offline");
}

export const othersCount = (listeners, counts) =>
  Math.max(0, count(listeners) - count(counts?.hosts) - count(counts?.speakers));

function firstGrapheme(text) {
  try {
    if (typeof Intl !== "undefined" && Intl.Segmenter) {
      const step = new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)[Symbol.iterator]().next();
      if (!step.done) return step.value.segment;
    }
  } catch { /* fall back to the first code point */ }
  return [...text][0];
}

/** One glyph for a face with no picture. A leading @ is skipped: "@bob" reads as B. */
export function initials(name) {
  const text = String(name || "").replace(/^@+/, "").trim();
  return text ? firstGrapheme(text).toUpperCase() : "?";
}

const plural = (n, word) => (n > 0 ? `${formatCount(n)} ${word}${n === 1 ? "" : "s"}` : "");

/** What a screen reader hears once the scan lands. */
export function rosterSentence(data) {
  if (!data) return "";
  if (data.state === "ended") return "This Space has ended.";
  if (data.state === "scheduled") return "This Space hasn't started yet.";
  const cohosts = Math.max(0, data.counts.hosts - (data.host ? 1 : 0));
  const named = data.host || data.cohosts.length || data.speakers.length;
  const parts = [
    data.host ? `host @${data.host.username}` : "",
    plural(cohosts, "co-host"),
    plural(data.counts.speakers, "speaker"),
    data.others > 0 ? `${formatCount(data.others)} ${data.others === 1 ? "other" : "others"} listening` : "",
  ].filter(Boolean);
  return `Crew: ${[named ? "" : "nobody named on the mic", ...parts].filter(Boolean).join(", ")}.`;
}

const REASON_STATE = new Map([["budget", "resting"], ["credits", "resting"], ["rate", "busy"],
                              ["no-key", "nokey"], ["cooling", "cooling"]]);

/** Which screen a scan result gets. */
export function stateFor(result) {
  if (!result || result.ok !== true) return REASON_STATE.get(result?.reason) || "offline";
  const d = result.data;
  if (!d) return "offline";
  if (d.state === "ended" || d.state === "scheduled") return d.state;
  if (!d.host && !d.cohosts.length && !d.speakers.length) return "empty";
  return d.mode === "host-only" ? "hostonly" : "ready";
}

export const LIVE_STATES = new Set(["ready", "empty", "hostonly"]);

// Headline (shown in the status line), body, the note's buttons, and whether
// OPEN IN X takes over as the big button because the radio can't help here.
const NOTES = {
  empty: { head: "", body: "X didn't name anyone on the mic right now.", actions: [] },
  hostonly: { head: "", body: "Only the host is shown today. X's own page shows everyone.", actions: [] },
  ended: { head: "THIS SHIP HAS LEFT", body: "The Space ended, so X no longer lists who was aboard.",
           actions: ["next"], lead: "openx" },
  scheduled: { head: "THIS SHIP HASN'T LAUNCHED", body: "The Space is scheduled but not live yet.", actions: [] },
  resting: { head: "CREW SCANNER RESTING", lead: "openx", actions: [],
             body: "X charges this radio for every name, and today's allowance is used up. It refills at midnight UTC. X's own page shows everyone for free:" },
  busy: { head: "X IS BUSY", body: "Try again in a minute.", actions: ["retry"] },
  nokey: { head: "NO SCANNER KEY", lead: "openx", actions: [],
           body: "This radio can't look up names without its X key. X's own page shows everyone:" },
  offline: { head: "CAN'T REACH THE TOWER", body: "The crew scan didn't come back.", actions: ["retry"] },
};
export const ACTION_LABEL = Object.freeze({ retry: "TRY AGAIN", next: "NEXT LIVE ROOM" }); // crew.js adds the ▸

/** The note under the roster for a screen, or null when the roster says it all. */
export function noteFor(state, { left = 0 } = {}) {
  if (state === "cooling") {
    const minutes = Math.round(SCAN_WINDOW_MS / 60_000);
    const waiting = `Names cost this radio money, so scans are limited to ${SCAN_MAX_ROOMS} rooms every ${minutes} minutes.`;
    return left > 0
      ? { head: "SCANNER COOLING DOWN", body: `${waiting} Try again in ${mmss(left)}, or:`, actions: [], lead: "openx" }
      : { head: "SCANNER COOLING DOWN", body: `${waiting} The scanner is ready again.`, actions: ["retry"], lead: "openx" };
  }
  return NOTES[state] || null;
}

export function mmss(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function liveFor(startedAt, now) {
  const t = Date.parse(startedAt);
  if (!t) return "LIVE";
  const min = Math.max(0, Math.round((now - t) / 60000));
  if (min < 1) return "JUST STARTED";
  return min < 60 ? `LIVE ${min}M` : `LIVE ${Math.floor(min / 60)}H${String(min % 60).padStart(2, "0")}`;
}

/** "● LIVE 1H12 · EN · 1,204 ABOARD" from a deck room or a scan. */
export function metaLine({ state, started_at, lang, listeners }, now = Date.now()) {
  const when = { live: `● ${liveFor(started_at, now)}`, ended: "ENDED", scheduled: "SCHEDULED" }[state] || "";
  const code = readLang(lang);
  const tongue = code && code !== "other" && code !== "und" ? code.toUpperCase() : "";
  const aboard = state !== "ended" && typeof listeners === "number" ? `${formatCount(listeners)} ABOARD` : "";
  return [when, tongue, aboard].filter(Boolean).join(" · ");
}

export function ageWords(at, now = Date.now()) {
  const min = Math.floor(Math.max(0, now - at) / 60000);
  return min < 1 ? "JUST NOW" : `${min} MIN AGO`;
}

export const isStale = (at, now = Date.now()) => now - at > CREW_TTL_MS;

/** Placeholder rows while scanning: one per known voice, 1 to 12; 3 when the room is a mystery. */
export function skeletonCount(room) {
  if (!room || room.listeners == null) return 3;
  const n = count(room.hosts) + count(room.speakers);
  return Math.min(12, Math.max(1, n));
}

export const earDots = (others) => Math.min(EAR_DOTS, count(others));

/** Head words for a deck room before any scan: presets ("yours") have no known state. */
export const roomInfo = (room) => ({
  title: cleanText(room?.title, 200) || UNTITLED,
  state: room?.source === "yours" ? "" : "live",
  started_at: room?.started_at, lang: room?.lang,
  listeners: typeof room?.listeners === "number" ? room.listeners : null,
});

/** Head words after a scan. X drops the title of some ended rooms; the dial still knows it. */
export const headInfo = (room, data) =>
  (data.title === UNTITLED ? { ...data, title: roomInfo(room).title } : data);

export function kickerWords(label, status) {
  const clean = cleanText(label, 40);
  const pill = { onair: "ON AIR", lined: "LINED UP" }[status] || "";
  return { text: clean ? `CREW MANIFEST · ${clean}` : "CREW MANIFEST", pill, pillKind: pill ? status : "" };
}

/** Status line: the screen's headline, or "11 ON DECK · SCANNED JUST NOW" plus a spoken sentence. */
export function statusWords(state, data, now = Date.now()) {
  const head = noteFor(state)?.head;
  if (head) return { shown: head, spoken: head };
  if (!data) return { shown: "SCANNING CREW…", spoken: "Scanning crew…" };
  const onDeck = formatCount(data.counts.hosts + data.counts.speakers);
  return { shown: `${onDeck} ON DECK · SCANNED ${ageWords(data.at, now)}`, spoken: rosterSentence(data) };
}

const OPENX_LEADS = new Set(["resting", "nokey", "cooling", "ended"]);
/** When the radio can't help, X's own page becomes the big button. */
export const footLead = (state) => (OPENX_LEADS.has(state) ? "openx" : "listen");

/** The footer's listen link only ever points at X; anything else falls back to the Space. */
export const listenHref = (href, id) =>
  (typeof href === "string" && href.startsWith("https://x.com/") ? href : spaceLink(id));

export function personLabel(p) {
  const extra = [p.verified ? "verified on X" : "", p.protected ? "private account" : ""].filter(Boolean);
  const tail = extra.length ? `, ${extra.join(", ")}` : "";
  return `${p.name}, @${p.username}, ${ROLE_WORD[p.role]}${tail}. Opens their X profile.`;
}

/** Where the card sits on a wide screen: centered on the radio, 420 wide at most. */
export function anchorBox(rect) {
  if (!rect || !(rect.width > 0)) return null;
  const w = Math.round(Math.max(280, Math.min(420, rect.width - 24)));
  return { x: Math.round(rect.left + rect.width / 2), w };
}

export function hash(text) {
  let h = 2166136261;
  for (const ch of String(text)) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return h >>> 0;
}
export const glyphHue = (id) => hash(id) % 360;

/** A new room past the allowance cools down until the oldest room's last scan leaves the window. */
function coolingFor(live, id, maxRooms, windowMs) {
  const rooms = new Set(live.map((s) => s.id));
  if (rooms.size < maxRooms || rooms.has(id)) return null;
  const lastScan = [...rooms].map((r) => Math.max(...live.filter((s) => s.id === r).map((s) => s.at)));
  return { ...failure("cooling", "Scans are resting for a few minutes."), retryAt: Math.min(...lastScan) + windowMs };
}

/**
 * The crew request for a room. The ticket /api/tune gave the room (if any) rides along: the
 * server names the whole crew only for rooms its own search returned, and the host otherwise.
 */
export function crewPath(id, ticket) {
  const t = typeof ticket === "string" && TICKET.test(ticket) ? `&t=${ticket}` : "";
  return `/api/crew?id=${encodeURIComponent(id)}${t}`;
}

/**
 * Scans with a memory: one request per room in flight, a two-minute memo, and at most
 * maxRooms distinct rooms per rolling window. Only answered scans use up the allowance.
 */
export function createCrewStore({ fetchJson, now = Date.now, ttlMs = CREW_TTL_MS,
                                  windowMs = SCAN_WINDOW_MS, maxRooms = SCAN_MAX_ROOMS } = {}) {
  let memo = new Map();      // id -> CrewData; replaced on every write
  let inflight = new Map();  // id -> Promise<Result>
  let scans = [];            // [{ id, at }] scans in flight or answered

  const recent = (t) => scans.filter((s) => t - s.at < windowMs);

  function settle(id, entry, result) {
    inflight = new Map([...inflight].filter(([key]) => key !== id));
    if (result.ok) {
      const t = now();
      memo = new Map([...[...memo].filter(([key, d]) => key !== id && t - d.at <= CREW_KEEP_MS), [id, result.data]]);
    } else {
      scans = scans.filter((s) => s !== entry);
    }
    return result;
  }

  function scan(id, ticket) {
    const entry = { id, at: now() };
    scans = [...recent(entry.at), entry];
    const pending = Promise.resolve()
      .then(() => fetchJson(crewPath(id, ticket)))
      .then((body) => readCrewReply(body, id, now()))
      .catch(() => failure("offline"))
      .then((result) => settle(id, entry, result));
    inflight = new Map([...inflight, [id, pending]]);
    return pending;
  }

  return {
    get(id, ticket) {
      if (!spaceLink(id)) return Promise.resolve(failure("bad-id"));
      const t = now();
      const hit = memo.get(id);
      if (hit && t - hit.at < ttlMs) return Promise.resolve({ ok: true, data: hit });
      if (inflight.has(id)) return inflight.get(id);
      const cooling = coolingFor(recent(t), id, maxRooms, windowMs);
      return cooling ? Promise.resolve(cooling) : scan(id, ticket);
    },
    peek(id, t = now()) {
      const hit = memo.get(id);
      return hit && t - hit.at <= CREW_KEEP_MS ? hit : null;
    },
  };
}
