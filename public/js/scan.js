// SCAN: while you're in a room, line up the next ship every few minutes. You push to jump.
// Pure; tested in tests/scan.test.mjs.
const SCANNING = new Set(["airlock", "onair"]);

/** SCAN only runs while X has (or is opening) a room. */
export const scanning = (phase) => SCANNING.has(phase);

/** When the next hop is due, or 0 for none. */
export const nextScanAt = ({ scan, phase, now, minutes }) => (scan && scanning(phase) ? now + minutes * 60000 : 0);

/** Time for a hop? Never while the crew manifest is open: its buttons name one room, and
 *  moving the needle under them would make PUSH board a different ship. It hops once it closes. */
export function scanDue({ scan, phase, scanAt, now, crewOpen }) {
  return Boolean(scan) && scanning(phase) && scanAt > 0 && now >= scanAt && !crewOpen;
}
