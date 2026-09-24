// Beam a friend aboard: a link that opens their radio tuned to the room you're on,
// so you can end up in the same Space together. Pure helpers are tested in tests/beam.test.mjs.
import { parseSpaceId } from "./rooms.js";

const TITLE_MAX = 80;
// Control characters and bidirectional overrides can't ride in on a shared link.
const UNSAFE = /[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g;

export const cleanTitle = (text) => String(text ?? "").replace(UNSAFE, "").trim().slice(0, TITLE_MAX);

export function beamUrl(origin, room, band) {
  const q = new URLSearchParams({ beam: room.id });
  if (band) q.set("band", band);
  const title = cleanTitle(room.title);
  if (title) q.set("title", title);
  return `${origin}/?${q}`;
}

/** The beam in a page's query string, or null. The band is kept only if this radio has it. */
export function readBeam(search, hasBand) {
  const q = new URLSearchParams(search || "");
  const raw = q.get("beam") || "";
  const id = parseSpaceId(raw);
  if (!id || id !== raw) return null;
  const band = q.get("band");
  return Object.freeze({ id, band: band && hasBand(band) ? band : null, title: cleanTitle(q.get("title")) || "Beamed room" });
}

/** Phone: the share sheet. Computer: the clipboard. Returns what happened. */
export async function sendBeam(url, title, { phone, nav = navigator, text } = {}) {
  if (phone && nav.share) {
    try {
      await nav.share({ title: "Space Radio", text: text || `Come hear "${title}" with me on Space Radio`, url });
      return "shared";
    } catch (err) {
      if (err?.name === "AbortError") return "cancelled";
    }
  }
  try {
    await nav.clipboard.writeText(url);
    return "copied";
  } catch {
    return "failed";
  }
}
