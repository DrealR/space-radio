// Walkie-talkie handoff. On X, the web can only listen; talking needs the X phone app.
// So on a computer the radio listens, and MIC hands the room to your phone as a QR code
// of its canonical x.com/i/spaces link. (The big button's words live in airlock-copy.js.)
import qrcode from "../vendor/qrcode.mjs";

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
