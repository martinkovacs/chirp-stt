import "@fontsource/ibm-plex-sans/400.css";
import "@fontsource/ibm-plex-sans/500.css";
import "@fontsource/jetbrains-mono/500.css";
import "./style.css";
import { startCapture, type Capture } from "./capture.ts";
import type { OverlayState, Settings } from "../../shared/types.ts";
import { langPair } from "../icons.ts";

const chirp = window.chirp;
const $ = (id: string) => document.getElementById(id)!;
const pill = $("pill");
const committedEl = $("committed");
const tentativeEl = $("tentative");
const hintEl = $("hint");
const statusEl = $("status");
const langsEl = $("langs");
const bars = Array.from(pill.querySelectorAll<HTMLElement>(".meter i"));

function renderLangs(s: Settings) {
  langsEl.replaceChildren(...langPair(s.sourceLanguage, s.targetLanguage));
}
void chirp.getSettings().then(renderLangs);
chirp.onSettings(renderLangs);

function setText(committed: string, tentative: string) {
  committedEl.textContent = committed ? committed + (tentative ? " " : "") : "";
  tentativeEl.textContent = tentative;
  hintEl.textContent = committed || tentative ? "" : "listening…";
}

chirp.onOverlay((s: OverlayState) => {
  pill.dataset.phase = s.phase;
  switch (s.phase) {
    case "listening":
      setText(s.committed, s.tentative);
      statusEl.textContent = "";
      break;
    case "finishing":
      setText(s.committed, s.tentative);
      statusEl.textContent = "";
      break;
    case "done":
      setText(s.text, "");
      hintEl.textContent = "";
      statusEl.textContent = "✓";
      break;
    case "error":
      setText("", "");
      hintEl.textContent = "";
      committedEl.textContent = s.message;
      statusEl.textContent = "error";
      break;
    case "hidden":
      break;
  }
});

// ---- level meter (smoothed, driven by local capture) ----
let level = 0;
let target = 0;
const weights = [0.55, 0.85, 1, 0.8, 0.5];
function tick() {
  level += (target - level) * 0.35;
  target *= 0.9;
  const norm = Math.min(1, Math.sqrt(level) * 3.2);
  pill.style.setProperty("--level", norm.toFixed(3));
  const t = performance.now() / 140;
  bars.forEach((b, i) => {
    const wobble = 0.75 + 0.25 * Math.sin(t + i * 1.7);
    b.style.height = `${4 + norm * 16 * weights[i] * wobble}px`;
  });
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);

// ---- capture ----
let capture: Capture | null = null;
let starting: Promise<void> | null = null;

chirp.onCaptureStart((deviceId) => {
  if (capture || starting) return;
  starting = startCapture(deviceId, (pcm, lvl) => {
    target = Math.max(target, lvl);
    chirp.sendAudio(pcm, lvl);
  })
    .then((c) => {
      capture = c;
    })
    .catch((err: unknown) => {
      chirp.sendCaptureError(err instanceof Error ? `${err.name}: ${err.message}` : String(err));
    })
    .finally(() => {
      starting = null;
    });
});

chirp.onCaptureStop(async () => {
  if (starting) await starting;
  capture?.stop();
  capture = null;
});
