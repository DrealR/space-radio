// Crew manifest: a hologram the speaker projects, naming who's aboard the tuned room.
// Self-contained: app.js imports it lazily and node tests import it with no DOM, so nothing
// touches document or window until openCrew runs. No innerHTML: every name here came from X.
import {
  ACTION_LABEL, LIVE_STATES, RETRY_WAIT_MS, ROLE_PILL, ageWords, anchorBox, avatarAt, cleanText,
  createCrewStore, earDots, footLead, formatCount, glyphHue, headInfo, initials, isStale, kickerWords,
  listenHref, metaLine, mmss, noteFor, personLabel, roomInfo, skeletonCount, spaceLink,
  stateFor, statusWords,
} from "./crew-model.js";

export * from "./crew-model.js";

const CLOSE_MS = 180;
const SWIPE_CLOSE_PX = 80;
const STAGGER_MAX = 12;
const FETCH_TIMEOUT_MS = 12_000;

function fetchJson(url) {
  const signal = globalThis.AbortSignal?.timeout?.(FETCH_TIMEOUT_MS);
  // Error envelopes arrive as 4xx/5xx, so the body is read whatever the status.
  return fetch(url, { headers: { accept: "application/json" }, credentials: "same-origin", signal })
    .then((r) => r.json());
}

const store = createCrewStore({ fetchJson });
let ui = null;       // the dialog and its parts, built on first open
let view = null;     // { id, room, opts, result, busyUntil }: replaced, never edited
let seq = 0;         // bumps per scan, so a late reply for an older scan is ignored
let ticker = 0;      // one 1 s tick while open: countdowns and the roster's age
let closeTimer = 0;

export const isCrewOpen = () => ui?.dialog.open === true;
export const cachedCrew = (roomId, now = Date.now()) => store.peek(roomId, now);

export function openCrew(room, opts = {}) {
  if (typeof document === "undefined" || !room || typeof room !== "object") return;
  const id = spaceLink(room.id) ? room.id : null;
  const wasOpen = isCrewOpen();
  const closing = wasOpen && ui.dialog.classList.contains("crew-closing");
  if (wasOpen && !closing && id && view?.id === id) return;
  ui = ui || build();
  stopClosing();
  view = { id, room, opts: opts || {}, result: null, busyUntil: 0 };
  place();
  paintHead(roomInfo(room));
  if (!wasOpen) {
    ui.dialog.showModal();
    ui.x.focus({ preventScroll: true });
    call(view.opts.sound, "open");
    clearInterval(ticker);
    ticker = setInterval(tick, 1000);
  }
  if (id) scan();
  else show({ ok: false, reason: "bad-id" });
}

export function closeCrew() {
  if (isCrewOpen() && !ui.dialog.classList.contains("crew-closing")) close(false);
}

function close(swiped) {
  call(view?.opts.sound, "close");
  seq += 1; // a scan that lands mid-close stays silent
  if (reducedMotion()) return shut();
  ui.dialog.classList.add("crew-closing");
  if (swiped) ui.dialog.classList.add("crew-dropping");
  closeTimer = setTimeout(shut, CLOSE_MS);
}

// Clean up now: Chromium fires the close event on the next frame, and a hidden page has none.
const shut = () => { if (ui.dialog.open) ui.dialog.close(); finish(); };

function stopClosing() {
  clearTimeout(closeTimer);
  ui.dialog.classList.remove("crew-closing", "crew-dropping");
}

/** Every way out (✕, Esc, backdrop, swipe, closeCrew, a native close) lands here exactly once. */
function finish() {
  if (ui.dialog.open || !view) return; // reopened since, or already cleaned up
  stopClosing();
  clearInterval(ticker);
  ui.card.style.transform = "";
  seq += 1;
  const { opts } = view;
  view = null;
  try { opts.returnFocus?.focus?.({ preventScroll: true }); } catch { /* element may be gone */ }
  call(opts.onClose);
}

/** App callbacks can't break the dialog: a throw is logged and the manifest carries on. */
function call(fn, ...args) {
  if (typeof fn !== "function") return;
  try { fn(...args); } catch (err) { console.warn("[spaces-radio] crew callback failed", err); }
}

const reducedMotion = () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
const sheetMode = () => window.matchMedia?.("(max-width: 599.98px)").matches === true;

function el(tag, className, text, attrs = {}) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  Object.entries(attrs).forEach(([name, value]) => node.setAttribute(name, value));
  return node;
}

function box(tag, className, ...children) {
  const node = el(tag, className);
  node.append(...children);
  return node;
}

const HIDDEN = { "aria-hidden": "true" };
const SVG_NS = "http://www.w3.org/2000/svg";

/** A glyph from the page's SVG sprite: the web fonts carry no arrows or checks, and some
 *  phones draw ↗ as an emoji. Without the sprite (a bare page), the plain character. */
function mark(id, char) {
  if (!document.getElementById(id)) return el("span", "crew-g-text", char, HIDDEN);
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("class", "crew-g");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  const use = document.createElementNS(SVG_NS, "use");
  use.setAttribute("href", `#${id}`);
  svg.append(use);
  return svg;
}

// CSSOM, not a style attribute, so a strict Content-Security-Policy never blocks it.
function styled(node, name, value) {
  node.style.setProperty(name, String(value));
  return node;
}

function build() {
  const dialog = el("dialog", "crew", null, { id: "crew", "aria-labelledby": "crew-title" });
  const card = el("div", "crew-card");
  const grab = el("div", "crew-grab", null, HIDDEN);
  const head = el("header", "crew-head");
  const kickerText = el("span", "crew-kicker-text");
  const pill = el("span", "crew-pill");
  const title = el("h2", "crew-title", null, { id: "crew-title", dir: "auto" });
  const meta = el("p", "crew-meta");
  const x = el("button", "crew-x", "✕", { type: "button", autofocus: "", "aria-label": "Close crew manifest" });
  head.append(box("p", "crew-kicker", kickerText, pill), title, meta, x);
  const status = el("p", "crew-status", null, { id: "crew-status", role: "status" });
  const body = el("div", "crew-body");
  const foot = buildFoot();
  card.append(grab, head, status, body, foot.foot);
  dialog.append(card);
  document.body.append(dialog);
  const parts = { dialog, card, grab, head, kickerText, pill, title, meta, x, status, body, ...foot };
  wire(parts);
  return parts;
}

function buildFoot() {
  const listenText = el("b");
  const listenSub = el("small");
  const listen = box("a", "crew-listen", listenText, listenSub);
  const openx = box("a", "crew-openx", box("b", "", "OPEN IN X ", mark("g-out", "↗")),
                    el("small", "", "the room on X: everyone aboard, share, or listen there"));
  const fineText = el("span");
  const refresh = el("button", "crew-refresh", "REFRESH", { type: "button" });
  const fine = box("p", "crew-fine", fineText, refresh);
  const tip = el("p", "crew-tip", "Tap anyone to open their X profile.");
  const foot = box("footer", "crew-foot", listen, openx, fine, tip);
  return { foot, listen, listenText, listenSub, openx, fine, fineText, refresh, tip };
}

function wire(parts) {
  const { dialog, x, listen, openx, refresh } = parts;
  let downOnBackdrop = false; // a drag that ends on the backdrop is not a backdrop click
  x.addEventListener("click", closeCrew);
  dialog.addEventListener("cancel", (e) => { e.preventDefault(); closeCrew(); });
  dialog.addEventListener("close", finish);
  dialog.addEventListener("pointerdown", (e) => { downOnBackdrop = e.target === dialog; });
  dialog.addEventListener("click", (e) => { if (e.target === dialog && downOnBackdrop) closeCrew(); });
  listen.addEventListener("click", onListen);
  openx.addEventListener("click", (e) => call(view?.opts.onOpenX, e));
  refresh.addEventListener("click", () => { if (view?.id) scan(); });
  [parts.grab, parts.head].forEach((handle) => wireSwipe(handle, parts.card));
  window.addEventListener("resize", () => { if (isCrewOpen()) place(); });
}

function onListen(e) {
  const listen = view?.opts.listen;
  if (!listen || listen.disabled) return;
  call(listen.onClick, e); // synchronous and first: the app may open X right here
  closeCrew();
}

/** On a phone the sheet follows a finger down; past 80 px it lets go. */
function wireSwipe(handle, card) {
  let drag = null; // { id, y, dy } while a finger pulls the sheet
  handle.addEventListener("pointerdown", (e) => {
    if (!sheetMode() || e.target.closest?.(".crew-x")) return;
    drag = { id: e.pointerId, y: e.clientY, dy: 0 };
    try { handle.setPointerCapture(e.pointerId); } catch { /* the drag still works without capture */ }
  });
  handle.addEventListener("pointermove", (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    drag = { ...drag, dy: Math.max(0, e.clientY - drag.y) };
    card.style.transform = `translateY(${drag.dy}px)`;
  });
  const release = (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const far = e.type === "pointerup" && drag.dy > SWIPE_CLOSE_PX;
    drag = null;
    if (far && isCrewOpen()) close(true);
    else card.style.transform = "";
  };
  handle.addEventListener("pointerup", release);
  handle.addEventListener("pointercancel", release);
}

/** Wide screens: center the card on the radio (CSS clamps it to the viewport). */
function place() {
  const spot = anchorBox(view.opts.anchor?.getBoundingClientRect?.());
  const { style } = ui.dialog;
  [["--crew-x", spot?.x], ["--crew-w", spot?.w]].forEach(([name, px]) =>
    (spot ? style.setProperty(name, `${px}px`) : style.removeProperty(name)));
}

function paintHead(info) {
  const kicker = kickerWords(view.opts.label, view.opts.status);
  ui.kickerText.textContent = kicker.text;
  ui.pill.textContent = kicker.pill;
  ui.pill.className = kicker.pillKind ? `crew-pill crew-pill-${kicker.pillKind}` : "crew-pill";
  ui.title.textContent = info.title;
  ui.meta.textContent = metaLine(info);
}

/** The status line shows short VFD words; screen readers hear the full sentence. */
function say({ shown, spoken }) {
  ui.status.replaceChildren(el("span", "", shown, HIDDEN), el("span", "crew-sr", spoken));
}

function scan() {
  seq += 1;
  const mine = seq;
  view = { ...view, result: null, busyUntil: 0 };
  ui.card.dataset.state = "loading";
  ui.body.setAttribute("aria-busy", "true");
  ui.body.replaceChildren(skeleton(skeletonCount(view.room)));
  say(statusWords("loading", null));
  paintFoot();
  store.get(view.id, view.room.ticket)
    .catch(() => ({ ok: false, reason: "offline" }))
    .then((result) => { if (mine === seq && isCrewOpen()) show(result); });
}

function skeleton(rows) {
  const list = el("ul", "crew-skel", null, HIDDEN);
  list.append(...Array.from({ length: rows },
    () => box("li", "", el("i"), el("span", "crew-bar"), el("span", "crew-bar crew-bar-short"))));
  return list;
}

function show(result) {
  const state = stateFor(result);
  const data = result.ok ? result.data : null;
  view = { ...view, result, busyUntil: result.reason === "rate" ? Date.now() + RETRY_WAIT_MS : 0 };
  ui.card.dataset.state = state;
  ui.body.removeAttribute("aria-busy");
  if (data) paintHead(headInfo(view.room, data));
  ui.body.replaceChildren(...rosterNodes(data, state), noteNode(state));
  say(statusWords(state, data));
  paintFoot();
  const { opts, id } = view;
  if (LIVE_STATES.has(state)) call(opts.onRoster, id, data);
  if (state === "ready" || state === "hostonly") call(opts.sound, "found");
  if (state === "ended") call(opts.onEnded, id);
}

function rosterNodes(data, state) {
  if (!data || !LIVE_STATES.has(state)) return [];
  const start = data.host ? 1 : 0;
  return [
    data.host && section("HOST", [personLink(data.host, 0, true)], "crew-sec crew-sec-host"),
    data.cohosts.length && section(`CO-HOSTS · ${data.cohosts.length}`, [peopleList(data.cohosts, start)]),
    data.speakers.length && section(`SPEAKERS · ${data.speakers.length}`,
                                    [peopleList(data.speakers, start + data.cohosts.length)]),
    earsSection(data.others),
  ].filter(Boolean);
}

const section = (title, children, className = "crew-sec") =>
  box("section", className, el("h3", "crew-sec-title", title), ...children);

const peopleList = (people, start) =>
  box("ul", "crew-list", ...people.map((p, i) => box("li", "", personLink(p, start + i, false))));

function earsSection(others) {
  const dots = el("div", "crew-dots", null, HIDDEN);
  dots.append(...Array.from({ length: earDots(others) }, (_, i) => styled(el("i"), "--d", i)));
  const note = el("p", "crew-ears-note", "X shares how many people are listening, not who. It only counts signed-in people.");
  return section(`LISTENING · ${formatCount(others)}`, [dots, note], "crew-ears");
}

/** Desktop links open a tab; on a phone they stay in the tab so the X app can catch them. */
const NEW_TAB = { target: "_blank", rel: "noopener noreferrer" };
function linkTarget(a) {
  Object.entries(NEW_TAB).forEach(([name, value]) =>
    (view.opts.phone ? a.removeAttribute(name) : a.setAttribute(name, value)));
}

function personLink(p, index, hero) {
  const a = styled(el("a", hero ? "crew-hero" : "crew-person", null, { href: p.profileUrl, "aria-label": personLabel(p) }),
                   "--i", Math.min(index, STAGGER_MAX));
  linkTarget(a);
  const who = box("span", "crew-who", el("span", "crew-name", p.name, { dir: "auto" }), handleLine(p));
  const go = el("span", "crew-go", null, HIDDEN);
  go.append(mark("g-out", "↗"));
  a.append(avatar(p, hero), who, go);
  return a;
}

function handleLine(p) {
  const line = box("span", "crew-line", el("span", "crew-handle", `@${p.username}`),
                   el("span", `crew-role crew-role-${p.role}`, ROLE_PILL[p.role]));
  if (p.verified) {
    const check = el("span", "crew-check", null, { role: "img", "aria-label": "verified", title: "Verified on X" });
    check.append(mark("g-check", "✓"));
    line.append(check);
  }
  if (p.protected) line.append(el("span", "crew-lock", "PRIVATE"));
  return line;
}

/** Big picture, then X's small one, then a letter on the person's own color. */
function avatar(p, hero) {
  const first = hero ? p.avatar : avatarAt(p.avatar, "x96");
  const tries = [first, p.avatarSmall].filter((url, i, all) => url && all.indexOf(url) === i);
  return box("span", `crew-av crew-av-${p.role}`, tries.length ? picture(p, hero ? 64 : 44, tries) : glyph(p));
}

function picture(p, px, tries) {
  const img = el("img", "", null, { alt: "", width: px, height: px, loading: "lazy",
                                    decoding: "async", referrerpolicy: "no-referrer" });
  const load = ([url, ...rest]) => {
    img.addEventListener("error", () => (rest.length ? load(rest) : img.replaceWith(glyph(p))), { once: true });
    img.src = url;
  };
  load(tries);
  return img;
}

const glyph = (p) =>
  styled(el("span", "crew-glyph", initials(p.name), HIDDEN), "background", `hsl(${glyphHue(p.id)} 35% 22%)`);

/** The note under the roster. The tick rebuilds it only when its words change, so focus stays put. */
function noteNode(state) {
  const note = noteFor(state, { left: (view.result?.retryAt || 0) - Date.now() });
  const panel = el("div", "crew-note");
  if (!note) return panel;
  const buttons = note.actions.filter(canAct).map(actionButton);
  if (note.body) panel.append(el("p", "crew-note-body", note.body));
  panel.append(...buttons);
  panel.dataset.sig = [note.body, ...buttons.map((b) => `${b.textContent}${b.disabled}`)].join("|");
  return panel;
}

const canAct = (action) => (action === "retry" ? Boolean(view.id) : typeof view.opts.onNext === "function");

function actionButton(action) {
  const wait = action === "retry" ? view.busyUntil - Date.now() : 0;
  const button = el("button", "crew-act", wait > 0 ? `${ACTION_LABEL.retry} · ${mmss(wait)}` : ACTION_LABEL[action],
                    { type: "button" });
  button.disabled = wait > 0;
  if (action === "next") button.append(" ", mark("g-tri", "▸"));
  button.addEventListener("click", action === "retry" ? scan : () => {
    const { onNext } = view.opts;
    closeCrew();
    call(onNext);
  });
  return button;
}

function paintFoot() {
  const { opts, id, result } = view;
  const state = result ? stateFor(result) : "loading";
  const listen = opts.listen && typeof opts.listen === "object" && state !== "ended" ? opts.listen : null;
  ui.listen.hidden = !listen;
  if (listen) paintListen(listen);
  const link = spaceLink(id);
  ui.openx.hidden = !link;
  if (link) ui.openx.href = link;
  linkTarget(ui.openx);
  ui.foot.dataset.lead = footLead(state);
  ui.tip.hidden = !(state === "ready" || state === "hostonly");
  paintFine();
}

function paintListen(listen) {
  const { listen: a, listenText, listenSub } = ui;
  listenText.textContent = cleanText(listen.text, 24) || "PUSH TO LISTEN";
  listenSub.textContent = cleanText(listen.sub, 60);
  listenSub.hidden = !listenSub.textContent;
  const href = listen.disabled ? null : listenHref(listen.href, view.id);
  if (href) a.href = href;
  else a.removeAttribute("href"); // no href: nothing to follow while the radio has no room
  a.setAttribute("aria-disabled", String(!href));
  linkTarget(a);
}

function paintFine() {
  const data = view.result?.ok ? view.result.data : null;
  ui.fine.hidden = !data;
  ui.fineText.textContent = data ? `ROSTER FROM X · ${ageWords(data.at)}` : "";
  ui.refresh.hidden = !data || !isStale(data.at); // REFRESH only once the roster is over two minutes old
}

function tick() {
  if (!view?.result) return;
  paintFine();
  const current = ui.body.querySelector(":scope > .crew-note");
  const next = noteNode(stateFor(view.result));
  if (current && current.dataset.sig !== next.dataset.sig) current.replaceWith(next);
}
