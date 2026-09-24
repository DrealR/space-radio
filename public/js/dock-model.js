// Docking, the pure half: dock codes, Rocky's tones, and what the tunnel says.
// No DOM, no network: tested in tests/dock.test.mjs. The server (spaces_radio/dock.py)
// checks the same code shape and the same four tones.

// Stars and ships from Project Hail Mary first, then neighbours.
export const DOCK_STARS = Object.freeze(["ERID", "TAU", "ADRIAN", "BLIPA", "VEGA", "LYRA", "NOVA",
  "ORION", "RIGEL", "DENEB", "ALTAIR", "SIRIUS", "CETI", "SOL"]);
const TOKEN = /^[A-Z]{3,6}-\d{2}\.[0-9a-f]{12}$/;
export const LOST_SECONDS = 20; // a partner quiet this long has lost signal

const hex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");

/** A dock code from 8 random bytes: ERID-42.3f9a0c1b2d4e (the part before the dot is what people say). */
export function makeToken(bytes) {
  const star = DOCK_STARS[bytes[0] % DOCK_STARS.length];
  return `${star}-${String(bytes[1] % 100).padStart(2, "0")}.${hex(bytes.slice(2, 8))}`;
}

export const makeShip = (bytes) => hex(bytes.slice(0, 8)); // 16 hex: this tab's ship
export const isToken = (t) => typeof t === "string" && TOKEN.test(t);
export const dockLabel = (token) => (isToken(token) ? token.split(".")[0] : "");
export const dockUrl = (origin, token) => `${origin}/?dock=${encodeURIComponent(token)}`;

export function readDock(search) {
  const token = new URLSearchParams(search || "").get("dock");
  return isToken(token) ? token : null;
}

// Rocky and Grace's first language was chords. Four words are enough to find a room together.
export const TONES = Object.freeze({
  fist: Object.freeze({ glyph: "✊", label: "FIST MY BUMP", says: "FIST MY BUMP", notes: [392, 523.25, 659.25] }),
  amaze: Object.freeze({ glyph: "✦", label: "AMAZE ×3", says: "AMAZE AMAZE AMAZE", notes: [523.25, 659.25, 783.99, 1046.5] }),
  come: Object.freeze({ glyph: "↑", label: "COME HERE", says: "COME TO MY ROOM", notes: [440, 554.37, 659.25, 880] }),
  onward: Object.freeze({ glyph: "↓", label: "ONWARD", says: "MOVING ON", notes: [659.25, 523.25, 392] }),
});
export const TONE_KINDS = Object.freeze(Object.keys(TONES));

const roomOf = (room) => (room && room.id ? { id: room.id, title: String(room.title || "").slice(0, 120),
  listeners: Number.isInteger(room.listeners) ? room.listeners : null } : null);

/** What this ship tells the server about itself on each beat. */
export function beatState({ room, band, air, tone, left = false }) {
  return { room: roomOf(room), band: String(band || "").slice(0, 24), air: Boolean(air), tone: tone || null, left };
}

/** A tone to send: numbered so the partner plays each one once. "come" carries your room. */
export function nextTone(kind, lastSeq, room) {
  if (!TONES[kind]) return null;
  return { kind, seq: lastSeq + 1, room: kind === "come" ? roomOf(room) : null };
}

/** The partner as the tunnel shows them. */
export function peerView(peer) {
  if (!peer || !peer.state) return { status: "waiting", room: null, air: false };
  const { state } = peer;
  if (state.left) return { status: "left", room: null, air: false };
  const status = peer.age > LOST_SECONDS ? "lost" : "docked";
  return { status, room: state.room || null, air: Boolean(state.air), band: state.band || "" };
}

/** The partner's tone if it's one we haven't played yet. */
export function freshTone(peer, seenSeq) {
  const tone = peer?.state?.tone;
  return tone && TONES[tone.kind] && tone.seq > seenSeq ? tone : null;
}

export const STATUS_WORDS = Object.freeze({
  off: "NO DOCK", waiting: "WAITING FOR A SHIP…", docked: "DOCKED", lost: "SIGNAL LOST",
  left: "THEY UNDOCKED", full: "DOCK FULL", offline: "RELAY OFFLINE",
});
