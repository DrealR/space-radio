// TRANSMIT: carry the tuned room out as a post idea. It opens the X Factory at
// reemifai.org/station with the room's title (and its host, if a crew scan already
// named one). Free: a plain link, no X call, and nothing is posted for you.
// Pure; tested in tests/transmit.test.mjs.

export const STATION_URL = "https://reemifai.org/station";
export const TOPIC_MAX = 120; // the station keeps the same cap

// Control characters, bidi overrides and other invisible marks can't ride out on a link.
const HIDDEN = /[\p{Cc}\p{Cf}]/gu;
const HANDLE = /^[A-Za-z0-9_]{1,15}$/;
// Names the radio gives a room it knows nothing about: not a topic worth carrying.
const PLACEHOLDERS = new Set(["untitled room", "preset room", "beamed room"]);

function topicOf(title) {
  const flat = String(title ?? "").replace(HIDDEN, " ").replace(/\s+/g, " ").trim();
  if (!flat || PLACEHOLDERS.has(flat.toLowerCase())) return "";
  const chars = Array.from(flat);
  return chars.length <= TOPIC_MAX ? flat : `${chars.slice(0, TOPIC_MAX - 1).join("").trimEnd()}…`;
}

/** The station link for this room, or null when there's nothing to transmit. */
export function transmitUrl(room, host, station = STATION_URL) {
  const topic = room ? topicOf(room.title) : "";
  if (!topic) return null;
  const q = new URLSearchParams({ from: "radio", topic });
  const handle = String(host ?? "").trim().replace(/^@/, "");
  if (HANDLE.test(handle)) q.set("host", handle);
  return `${station}?${q}#factory`;
}
