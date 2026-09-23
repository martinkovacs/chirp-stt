# Chirp

Hold-to-talk speech-to-text **with translation**, running fully offline. Hold a key, speak
(for example in Hungarian), watch the live transcript, release, and the text (for example
in English) gets pasted into whatever app has focus. It works like Wispr Flow, but runs locally.

- Engine: [transcribe.cpp](https://github.com/handy-computer/transcribe.cpp) with
  [Canary-1B-v2 Q8_0](https://huggingface.co/handy-computer/canary-1b-v2-gguf) (25 European
  languages, any↔any translation), GPU through Vulkan, with a CPU fallback.
- Electron tray app: runs from the system tray, shows a small overlay while you talk, and has a settings window.
- Linux/Wayland first (tested on KDE Plasma), and also Windows and macOS.

## How it works

| Piece | Linux / Wayland | Windows / macOS / X11 |
| --- | --- | --- |
| Hold-to-talk key | evdev (`/dev/input`, any key, e.g. Right Alt), falling back to the xdg GlobalShortcuts portal | uiohook |
| Paste | clipboard, then Ctrl+V from a `/dev/uinput` virtual keyboard | clipboard, then a uiohook key tap |
| Overlay | Electron window under XWayland (so it can be positioned and kept on top) | native |

Canary is not a streaming model, so the live preview works by re-decoding the audio that
isn't committed yet about every 400 ms. The GPU handles roughly 10 ms of work per second of audio, so this is cheap. Pauses split
the recording into segments that are committed and never decoded again, so long dictations stay fast.

When you hold Right Alt (AltGr) **by itself**, it records. If you press another key while holding
it (AltGr+V → `@`), the recording is cancelled, so typing special characters keeps working.

## Setup (Linux)

```sh
npm install
npm run dev          # or: npm run build && npm start
```

On first start the settings window offers to download the model (1.14 GB) into
`~/.config/chirp-stt/models/`.

**Permissions.** Wayland doesn't let apps see global key presses, so Chirp reads the keyboard directly:

```sh
sudo usermod -aG input $USER   # then log out and back in
```

Pasting uses `/dev/uinput`. Most systemd distros already grant the logged-in user access to it; if
yours doesn't, add a udev rule or use "Clipboard only" mode.

If you'd rather not join the `input` group, set the hotkey backend to **Desktop portal**. KDE asks you
once to confirm a shortcut (a combination such as Ctrl+Space; a lone Right Alt isn't possible there).
Or bind `chirp-stt --toggle` to any shortcut: press it once to start and again to stop.

## Packaging

```sh
npm run dist   # AppImage + deb on Linux, nsis on Windows, dmg on macOS
```

## Development

```sh
npm run typecheck
npm test
node --experimental-strip-types scripts/try-dictation.ts   # engine test on a raw 16 kHz f32 file
```
