// Where each ship sits on the bridge scope. Pure: no DOM, tested in tests/radar.test.mjs.
// Busier ships sit nearer the centre; each ship keeps its own bearing (from its id),
// so a room stays in the same place on the scope while its crowd grows or shrinks.
import { hash } from "./rooms.js";

export const SWEEP_SECONDS = 4;
const INNER = 0.14;   // the busiest ship, as a fraction of the scope's radius
const OUTER = 0.84;   // the quietest live ship
const EDGE = 0.93;    // presets and beamed rooms: crowd unknown, parked on the rim

const round = (n) => Math.round(n * 100) / 100;
// FNV alone clumps similar ids on nearby bearings; a murmur-style finish spreads them round the scope.
const mix = (h) => {
  const a = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  const b = Math.imul(a ^ (a >>> 13), 0xc2b2ae35);
  return (b ^ (b >>> 16)) >>> 0;
};
const count = (n) => (typeof n === "number" && n > 0 ? n : 0);

/** Busiest first, so Tab walks the scope from the biggest crowd down. */
export const byCrowd = (rooms) => [...rooms].sort((a, b) => count(b.listeners) - count(a.listeners));

/** Words for a blip: what a screen reader says and what the readout shows. */
export function blipLabel(room) {
  const title = room.title || "Untitled room";
  const partner = room.partner ? " · your partner is here" : "";
  if (typeof room.listeners !== "number") return `${title} · ${room.beamed ? "beamed in" : room.partner ? "your partner's ship" : "your preset"}${partner && !room.partner ? partner : ""}`;
  const mic = count(room.speakers) ? ` · ${room.speakers} on the mic` : "";
  return `${title} · ${room.listeners} aboard${mic}${partner}`;
}

/** One frozen blip per room, in the order given (the caller decides tab order).
 *  partnerId: the room your docked partner is on, drawn as a second ship. */
export function blipLayout(rooms, currentId, partnerId = null) {
  const max = Math.max(1, ...rooms.map((r) => count(r.listeners)));
  // Distance blends crowd size with crowd rank, so similar-sized rooms still spread into rings.
  const ranked = byCrowd(rooms.filter((r) => typeof r.listeners === "number")).map((r) => r.id);
  const spread = (id) => (ranked.length > 1 ? ranked.indexOf(id) / (ranked.length - 1) : 0);
  return rooms.map((room) => {
    const known = typeof room.listeners === "number";
    const weight = known ? Math.log1p(count(room.listeners)) / Math.log1p(max) : 0;
    const distance = known ? ((1 - weight) + spread(room.id)) / 2 : 1;
    const reach = known ? INNER + (OUTER - INNER) * distance : EDGE;
    const bearing = mix(hash(room.id)) % 360;
    const rad = ((bearing - 90) * Math.PI) / 180; // 0° is straight up, like the sweep's start
    return Object.freeze({
      id: room.id,
      x: round(50 + 50 * reach * Math.cos(rad)),
      y: round(50 + 50 * reach * Math.sin(rad)),
      size: known ? Math.round(10 + 18 * weight) : 10,
      delay: round((bearing / 360) * SWEEP_SECONDS), // lights up as the sweep passes
      kind: known ? "live" : "mine",
      mic: count(room.speakers) > 0,
      current: room.id === currentId,
      partner: room.id === partnerId,
      label: blipLabel({ ...room, partner: room.id === partnerId }),
    });
  });
}

