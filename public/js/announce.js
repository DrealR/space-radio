// One quiet voice for screen readers. The LCD changes too often to be a live region, so
// the moments that matter are said here: debounced, and never the same line twice in a row.
const DEBOUNCE_MS = 150;
const REPEAT_MS = 4000;

let timer = 0;
let last = { text: "", at: 0 };

export function say(text) {
  const line = String(text || "").trim();
  if (!line) return;
  clearTimeout(timer);
  timer = setTimeout(() => {
    const now = Date.now();
    if (line === last.text && now - last.at < REPEAT_MS) return;
    const node = document.getElementById("announcer");
    if (!node) return;
    node.textContent = line;
    last = { text: line, at: now };
  }, DEBOUNCE_MS);
}
