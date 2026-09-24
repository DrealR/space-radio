// The docking tunnel, the live half: the port card, the tunnel strip, and a heartbeat to the relay.
// (dock.js is something else: it docks the X window beside the radio.)
// Two ships, one tunnel. Each keeps its own dial and its own X; the relay carries only rooms and tones.
import { STATUS_WORDS, TONES, TONE_KINDS, beatState, dockLabel, dockUrl, freshTone, isToken, makeShip,
  makeToken, nextTone, peerView } from "./dock-model.js";
import { sendBeam } from "./beam.js";
import { chord, clamp, lost as lostSound } from "./sfx.js";
import { $, el, pulse } from "./dom.js";
import { readJson, removeRaw, writeJson } from "./store.js";

const KEY = "spaces-radio:dock"; // this tab's ship: session storage, so a reload keeps the dock
const FAST_MS = 2500;
const SLOW_MS = 8000;            // a hidden tab beats slowly
const RETRY_MS = 6000;
const HEADERS = { "content-type": "application/json" };
const random = (n) => crypto.getRandomValues(new Uint8Array(n));

function strip(on) {
  const button = (cls, text, click) => {
    const b = el("button", { type: "button", className: cls, textContent: text });
    b.addEventListener("click", click);
    return b;
  };
  const card = (who, cls) => el("div", { className: `tn-ship ${cls}` },
    el("small", { textContent: who }), el("b", { className: "tn-title" }), el("span", { className: "tn-meta" }));
  const tones = TONE_KINDS.map((kind) => {
    const t = TONES[kind];
    const b = button("tn-tone", `${t.glyph} ${t.label}`, () => on.send(kind));
    b.dataset.kind = kind;
    b.setAttribute("aria-label", `Send tone: ${t.says.toLowerCase()}`);
    return b;
  });
  return [
    el("header", { className: "tn-head" },
      el("span", { className: "tn-code" }), el("span", { className: "tn-status" }),
      button("tn-x", "UNDOCK ✕", on.undock)),
    el("div", { className: "tn-ships" }, card("YOU", "me"),
      el("div", { className: "tn-wall", title: "The xenonite wall: contact without collapse" }, el("i")),
      card("PARTNER", "them")),
    el("div", { className: "tn-tones" }, ...tones),
    button("tn-go", "GO TO THEIR ROOM ▸", on.visit),
  ];
}

export function createDock(app) {
  let ship = null; // { token, role, ship, seen }
  let view = { status: "off", peer: null, mine: null, invite: null, error: "" };
  let timer = 0;
  let busy = false;
  let port = null;

  const label = () => (ship ? dockLabel(ship.token) : "");
  const docked = () => view.status === "docked";
  const save = () => ship && writeJson(KEY, ship, "session");
  const setView = (patch) => { view = { ...view, ...patch }; draw(); };
  const onAir = () => app.state.air.phase === "onair";

  function schedule(ms) {
    clearTimeout(timer);
    if (ship) timer = setTimeout(beatOnce, document.hidden ? Math.max(ms, SLOW_MS) : ms);
  }

  function hear(tone) {
    const t = TONES[tone.kind];
    if (app.sfxOk()) chord(t.notes);
    app.flash(`${t.glyph} ${t.says} · FROM YOUR PARTNER`, 4500);
    app.say(`Your partner says: ${t.says.toLowerCase()}.`);
    pulse($("tunnel"), "rx", 1400);
  }

  function land(peer) {
    const was = view.status;
    const pv = peerView(peer);
    const tone = freshTone(peer, ship.seen);
    if (tone) { ship = { ...ship, seen: tone.seq }; save(); }
    const invite = tone?.kind === "come" && tone.room ? tone.room : view.invite;
    setView({ status: pv.status, peer: pv, invite, error: "" });
    if (pv.status === "docked" && was !== "docked") {
      if (app.sfxOk()) clamp();
      app.flash(`DOCKED · ${label()} · TONES ARE LIVE`, 4000);
      app.say("Docked. You can see your partner's ship and send tones.");
      pulse($("tunnel"), "clamped", 1600);
    }
    if (pv.status === "lost" && was === "docked" && app.sfxOk()) lostSound();
    if (pv.status === "left" && was !== "left") app.flash("YOUR PARTNER UNDOCKED", 4000);
    if (tone) hear(tone);
  }

  async function beatOnce() {
    if (!ship || busy) return;
    busy = true;
    const mine = ship;
    const state = beatState({ room: app.current(), band: app.state.band, air: onAir(), tone: view.mine });
    let wait = FAST_MS;
    try {
      const res = await fetch("/api/dock", { method: "POST", headers: HEADERS,
        body: JSON.stringify({ token: mine.token, role: mine.role, ship: mine.ship, state }) });
      const body = await res.json().catch(() => ({}));
      if (ship !== mine) return; // undocked while this beat was in flight
      if (res.status === 409) {
        stop();
        setView({ status: "full" });
        app.flash("DOCK FULL · IT ALREADY HAS TWO SHIPS", 4500);
      } else if (!body.success) {
        setView({ status: res.status === 503 ? "offline" : view.status, error: body.error || "Relay trouble." });
        wait = RETRY_MS;
      } else {
        land(body.data?.peer);
      }
    } catch {
      setView({ error: "The relay can't be reached. Retrying." });
      wait = RETRY_MS;
    } finally {
      busy = false;
      schedule(wait);
    }
  }

  function start(next) {
    ship = next;
    save();
    setView({ status: "waiting", peer: null, mine: null, invite: null, error: "" });
    beatOnce();
  }

  function stop() {
    clearTimeout(timer);
    ship = null;
    removeRaw(KEY, "session");
  }

  async function undock() {
    const leaving = ship;
    stop();
    setView({ status: "off", peer: null, invite: null, mine: null });
    if (port?.open) port.close();
    if (!leaving) return;
    app.flash("UNDOCKED · THE TUNNEL IS CLOSED", 2500);
    try {
      await fetch("/api/dock", { method: "POST", headers: HEADERS, keepalive: true,
        body: JSON.stringify({ token: leaving.token, role: leaving.role, ship: leaving.ship, state: beatState({ left: true }) }) });
    } catch { /* the slot expires on its own */ }
  }

  function send(kind) {
    if (!ship || !docked()) return;
    const tone = nextTone(kind, view.mine?.seq || 0, app.current());
    if (!tone) return;
    setView({ mine: tone });
    if (app.sfxOk()) chord(TONES[kind].notes);
    app.flash(`SENT ${TONES[kind].glyph} ${TONES[kind].says}`, 2200);
    clearTimeout(timer);
    beatOnce();
  }

  function visit() {
    const room = view.invite || view.peer?.room;
    if (!room) return;
    if (!app.deck().some((r) => r.id === room.id)) app.set({ beam: { id: room.id, title: room.title } });
    app.select(room.id);
    app.flash("HEADING TO THEIR SHIP · PUSH TO JOIN", 3500);
    setView({ invite: null });
  }

  // ---- the docking port card -----------------------------------------------------------
  function buildPort() {
    const sendLink = el("button", { type: "button", className: "dp-send", textContent: "SEND DOCKING LINK" });
    sendLink.addEventListener("click", async () => {
      if (!ship) return;
      const sent = await sendBeam(dockUrl(location.origin, ship.token), label(),
        { phone: app.device.kind === "phone", text: `Dock with my Space Radio (${label()})` });
      document.getElementById("dp-note").textContent =
        { shared: "Sent. Keep this radio open.", copied: "Link copied. Send it to one friend.", cancelled: "", failed: "Copy blocked. Select the code and share it." }[sent];
    });
    const close = el("button", { type: "button", className: "dp-close", textContent: "Close" });
    close.addEventListener("click", () => port.close());
    const d = el("dialog", { id: "dockport", className: "dockport" },
      el("div", { className: "dp-card" },
        el("p", { className: "dp-kicker", textContent: "Docking port" }),
        el("div", { className: "dp-rings", ariaHidden: "true" }, el("i"), el("i"), el("i")),
        el("h2", { id: "dp-code", className: "dp-code" }),
        el("p", { id: "dp-status", className: "dp-status", role: "status" }),
        el("p", { className: "dp-lede", textContent: "Send this link to one friend. When their radio opens it, your ships dock through a tunnel: you each keep your own dial and your own X, you see each other on the radar, and you speak in tones. The real talking happens inside the Space." }),
        sendLink, el("p", { id: "dp-note", className: "dp-note" }), close));
    d.setAttribute("aria-labelledby", "dp-code");
    d.addEventListener("click", (e) => { if (e.target === d) d.close(); });
    document.body.append(d);
    return d;
  }

  function open() {
    if (!ship) start({ token: makeToken(random(8)), role: "a", ship: makeShip(random(8)), seen: 0 });
    port = port || buildPort();
    draw();
    if (!port.open) port.showModal();
  }

  function join(token) {
    const saved = readJson(KEY, null, "session");
    start(saved?.token === token ? saved : { token, role: "b", ship: makeShip(random(8)), seen: 0 });
    app.flash(`DOCKING WITH ${dockLabel(token)}…`, 3000);
  }

  function restore() {
    const saved = readJson(KEY, null, "session");
    if (saved && isToken(saved.token) && ["a", "b"].includes(saved.role) && /^[0-9a-f]{16}$/.test(saved.ship)) start(saved);
  }

  // ---- drawing --------------------------------------------------------------------------
  function drawCard(node, room, meta) {
    node.querySelector(".tn-title").textContent = room ? room.title : "—";
    node.querySelector(".tn-meta").textContent = meta;
  }

  function draw() {
    const box = $("tunnel");
    const chip = $("dock-btn");
    if (chip) {
      chip.textContent = ship ? `${docked() ? "DOCKED" : "PORT OPEN"} ⟷` : "DOCK ⟷";
      chip.classList.toggle("on", docked());
    }
    if (port) {
      document.getElementById("dp-code").textContent = label() || "—";
      document.getElementById("dp-status").textContent = view.error || STATUS_WORDS[view.status];
      port.dataset.status = view.status;
    }
    if (!box) return;
    const show = Boolean(ship) || view.status === "full" || view.status === "left";
    box.hidden = !show;
    if (!show) return;
    if (!box.firstChild) box.append(...strip({ send, undock, visit }));
    box.dataset.status = view.status;
    box.querySelector(".tn-code").textContent = `⟷ TUNNEL · ${label() || "CLOSED"}`;
    box.querySelector(".tn-status").textContent = view.error && ship ? view.error : STATUS_WORDS[view.status];
    box.querySelector(".tn-x").textContent = ship ? "UNDOCK ✕" : "CLOSE ✕";
    const room = app.current();
    drawCard(box.querySelector(".tn-ship.me"), room, onAir() ? "ON AIR" : "BROWSING");
    const peer = view.peer;
    const theirs = peer?.room && docked() ? peer.room : null;
    const meta = !docked() ? STATUS_WORDS[view.status]
      : [theirs?.listeners != null ? `${theirs.listeners} ABOARD` : "", peer?.air ? "ON AIR" : "BROWSING"].filter(Boolean).join(" · ");
    drawCard(box.querySelector(".tn-ship.them"), theirs, meta);
    box.querySelectorAll(".tn-tone").forEach((b) => { b.disabled = !docked(); });
    const target = view.invite || theirs;
    const go = box.querySelector(".tn-go");
    go.hidden = !target || target.id === room?.id;
    go.textContent = view.invite ? `THEY CALLED YOU OVER · GO TO "${view.invite.title.slice(0, 32)}" ▸` : "GO TO THEIR ROOM ▸";
  }

  document.addEventListener("visibilitychange", () => { if (ship && !document.hidden) schedule(0); });

  return {
    open, join, restore, undock, send, draw,
    /** The partner's room while docked, for the radar. */
    partnerRoom: () => (docked() || view.status === "lost" ? view.peer?.room || null : null),
  };
}
