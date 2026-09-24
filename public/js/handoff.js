// Walkie-talkie handoff. On X, the web can only listen; talking needs the X phone app.
// So on a computer the radio listens, and MIC hands the room to your phone as a QR code.
import qrcode from "../vendor/qrcode.mjs";

/** Words on the big button: by device, whether you're on air, and whether this is the room playing. */
export function joinCopy({ phone, listening, here = true, steer = "unknown" }) {
  if (!listening) {
    return phone
      ? { text: "PUSH TO JOIN", sub: "opens the X app · listen or request the mic" }
      : { text: "PUSH TO LISTEN", sub: "plays in X on the web · to talk, press MIC" };
  }
  if (!here) {
    return phone
      ? { text: "PUSH TO SWITCH", sub: "opens this room in the X app" }
      : { text: "PUSH TO SWITCH", sub: "opens in a new X tab · close the old one" };
  }
  if (phone) return { text: "YOU'RE IN", sub: "tap to reopen · come back and swipe for more" };
  return { text: "LISTENING", sub: steer === "yes"
    ? "the X window follows the dial · MIC to talk"
    : "playing in your X tab · MIC to talk" };
}

/** QR modules as one SVG path in module units (quiet zone added by the caller). */
export function qrPath(url) {
  const qr = qrcode(0, "M");
  qr.addData(url);
  qr.make();
  const size = qr.getModuleCount();
  let d = "";
  for (let row = 0; row < size; row++) {
    for (let col = 0; col < size; col++) {
      if (qr.isDark(row, col)) d += `M${col} ${row}h1v1h-1z`;
    }
  }
  return { size, d };
}

const SVG_NS = "http://www.w3.org/2000/svg";
const QUIET = 3;

export function qrSvg(url) {
  const { size, d } = qrPath(url);
  const full = size + QUIET * 2;
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", `${-QUIET} ${-QUIET} ${full} ${full}`);
  svg.setAttribute("shape-rendering", "crispEdges");
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", "QR code for this room");
  const bg = document.createElementNS(SVG_NS, "rect");
  Object.entries({ x: -QUIET, y: -QUIET, width: full, height: full, fill: "#fffaf0" })
    .forEach(([k, v]) => bg.setAttribute(k, v));
  const path = document.createElementNS(SVG_NS, "path");
  path.setAttribute("d", d);
  path.setAttribute("fill", "#1a120d");
  svg.append(bg, path);
  return svg;
}
