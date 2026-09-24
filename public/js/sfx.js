// Tiny synthesized sounds, made with Web Audio so there are no files. Only ever started
// by a tap or key press. Rules: every sound peaks at gain .06 or less, lasts 700 ms or
// less and never loops. None of this touches X's audio.

const PEAK = 0.06;
let ctx = null;

function audio() {
  const Ctor = window.AudioContext || window.webkitAudioContext;
  if (!Ctor) return null;
  ctx = ctx || new Ctor();
  if (ctx.state === "suspended") ctx.resume();
  return ctx;
}

/** Run a sound; a missing or refused AudioContext just means silence. */
function play(name, draw) {
  try {
    const ac = audio();
    if (ac) draw(ac, ac.currentTime);
  } catch (err) {
    console.warn(`[spaces-radio] ${name} sound unavailable`, err);
  }
}

function tone(ac, { type = "sine", hz, to, at, len, gain }) {
  const t = ac.currentTime + at;
  const osc = ac.createOscillator();
  const amp = ac.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(hz, t);
  if (to) osc.frequency.exponentialRampToValueAtTime(to, t + len);
  amp.gain.setValueAtTime(0.0001, t);
  amp.gain.exponentialRampToValueAtTime(Math.min(gain, PEAK), t + Math.min(0.01, len / 4));
  amp.gain.exponentialRampToValueAtTime(0.0001, t + len);
  osc.connect(amp).connect(ac.destination);
  osc.start(t);
  osc.stop(t + len + 0.02);
}

function noise(ac, { at = 0, len, hz, q = 0.8, gain, attack = 0.03 }) {
  const t = ac.currentTime + at;
  const frames = Math.max(1, Math.floor(ac.sampleRate * len));
  const buffer = ac.createBuffer(1, frames, ac.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < frames; i++) data[i] = Math.random() * 2 - 1;
  const src = ac.createBufferSource();
  src.buffer = buffer;
  const band = ac.createBiquadFilter();
  band.type = "bandpass";
  band.frequency.value = hz;
  band.Q.value = q;
  const amp = ac.createGain();
  amp.gain.setValueAtTime(0.0001, t);
  amp.gain.exponentialRampToValueAtTime(Math.min(gain, PEAK), t + Math.min(attack, len / 2));
  amp.gain.exponentialRampToValueAtTime(0.0001, t + len);
  src.connect(band).connect(amp).connect(ac.destination);
  src.start(t);
}

/** Static between rooms. */
export function staticBurst(seconds = 0.32) {
  play("static", (ac) => noise(ac, { len: seconds, hz: 1400 + Math.random() * 1400, gain: PEAK }));
}

/** Roger beep: you pressed PUSH. */
export function rogerBeep() {
  play("beep", (ac) => {
    tone(ac, { type: "square", hz: 1250, at: 0, len: 0.07, gain: 0.045 });
    tone(ac, { type: "square", hz: 880, at: 0.08, len: 0.1, gain: 0.045 });
  });
}

/** Hailing: two sonar pings after the roger beep. */
export function hail() {
  play("hail", (ac) => [0.22, 0.44].forEach((at) => tone(ac, { hz: 1480, at, len: 0.03, gain: 0.025 })));
}

/** Signal lock: a glide up, then a small tink. */
export function lock() {
  play("lock", (ac) => {
    tone(ac, { hz: 520, to: 1040, at: 0, len: 0.14, gain: 0.05 });
    tone(ac, { hz: 2080, at: 0.15, len: 0.06, gain: 0.02 });
  });
}

/** Lost track of X: two square blips going down. */
export function lost() {
  play("lost", (ac) => {
    tone(ac, { type: "square", hz: 660, at: 0, len: 0.05, gain: 0.03 });
    tone(ac, { type: "square", hz: 440, at: 0.07, len: 0.05, gain: 0.03 });
  });
}

/** A soft detent: the knob, or a question waiting below. */
export function tick() {
  play("tick", (ac) => noise(ac, { len: 0.003, hz: 3000, q: 1.2, gain: 0.02, attack: 0.001 }));
}

/** The crew hologram: open, close, and a tick when names arrive. */
export function holo(name) {
  play("holo", (ac) => {
    if (name === "open") {
      noise(ac, { len: 0.4, hz: 4000, q: 2, gain: 0.03, attack: 0.18 });
      tone(ac, { hz: 180, at: 0, len: 0.2, gain: 0.02 });
    } else if (name === "close") {
      noise(ac, { len: 0.09, hz: 4000, q: 2, gain: 0.02, attack: 0.01 });
    } else if (name === "found") {
      tone(ac, { hz: 2200, at: 0, len: 0.012, gain: 0.015 });
    }
  });
}
