// MIC: carry the room to your phone. On X the web can only listen; talking needs the
// X app and an account, so a computer shows a QR ticket of the room's canonical link.
import { qrSvg } from "./handoff.js";
import { spaceUrl } from "./rooms.js";
import { $, el } from "./dom.js";

export function openHandoff(room) {
  const url = room && spaceUrl(room.id);
  if (!url) return;
  $("handoff-room").textContent = room.title;
  try {
    $("handoff-qr").replaceChildren(qrSvg(url));
  } catch (err) {
    console.warn("[spaces-radio] QR failed", err);
    $("handoff-qr").replaceChildren(el("p", { textContent: url }));
  }
  $("handoff-copy").textContent = "Copy link";
  $("handoff").showModal();
}

export async function copyRoomLink(room) {
  const url = room && spaceUrl(room.id);
  if (!url) return;
  try {
    await navigator.clipboard.writeText(url);
    $("handoff-copy").textContent = "Copied ✓";
  } catch {
    $("handoff-copy").textContent = "Copy blocked";
  }
}
