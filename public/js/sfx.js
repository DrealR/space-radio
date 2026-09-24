// Tiny synthesized sounds: static between rooms, a roger beep when you join.
// Made with Web Audio, so no files; only ever started by a tap or key press.

let ctx = null;

function audio() {
  const Ctor = window.AudioContext || window.webkitAudioContext;
  if (!Ctor) return null;
  ctx = ctx || new Ctor();
  if (ctx.state === "suspended") ctx.resume();
  return ctx;
}

export function staticBurst(seconds = 0.32) {
  try {
    const ac = audio();
    if (!ac) return;
    const frames = Math.floor(ac.sampleRate * seconds);
    const buffer = ac.createBuffer(1, frames, ac.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < frames; i++) data[i] = Math.random() * 2 - 1;
    const src = ac.createBufferSource();
    src.buffer = buffer;
    const band = ac.createBiquadFilter();
    band.type = "bandpass";
    band.frequency.value = 1400 + Math.random() * 1400;
    band.Q.value = 0.8;
    const gain = ac.createGain();
    const t = ac.currentTime;
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.16, t + 0.03);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + seconds);
    src.connect(band).connect(gain).connect(ac.destination);
    src.start(t);
  } catch (err) {
    console.warn("[spaces-radio] static sound unavailable", err);
  }
}

export function rogerBeep() {
  try {
    const ac = audio();
    if (!ac) return;
    const t = ac.currentTime;
    [[1250, 0, 0.07], [880, 0.08, 0.1]].forEach(([hz, at, len]) => {
      const osc = ac.createOscillator();
      const gain = ac.createGain();
      osc.type = "square";
      osc.frequency.value = hz;
      gain.gain.setValueAtTime(0.045, t + at);
      gain.gain.setValueAtTime(0, t + at + len);
      osc.connect(gain).connect(ac.destination);
      osc.start(t + at);
      osc.stop(t + at + len + 0.01);
    });
  } catch (err) {
    console.warn("[spaces-radio] beep unavailable", err);
  }
}
