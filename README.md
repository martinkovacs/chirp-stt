# Chirp

Hold-to-talk speech-to-text **with translation**, running fully offline.

Hold a key, speak (for example in Hungarian), watch the live transcript appear, release,
and the text (for example in English) is pasted into whatever app has focus. It works like
Wispr Flow, but runs locally on your own GPU.

- **Engine:** [transcribe.cpp](https://github.com/handy-computer/transcribe.cpp) with
  [Canary-1B-v2 Q8_0](https://huggingface.co/handy-computer/canary-1b-v2-gguf):
  25 European languages, transcription or any↔any translation.
- **GPU:** Vulkan (NVIDIA, AMD, Intel), or CUDA / ROCm / Metal where transcribe.cpp provides
  them; pick one in Settings → Engine. The CPU backend runs the regular Q8_0 model whenever
  Chirp can host the speech engine under Node.js ≥ 22 (a bundled binary in release builds;
  the system `node` during development). Without a Node.js runtime it falls back to the
  smaller Q4_K_M model (735 MB, downloaded on demand), because Electron's allocator can't
  hold the Q8 weights in one block.
- **Lives in the tray:** a small overlay shows the live text while you talk, and a settings
  window holds languages, hotkey, output mode and history.
- **Platforms:** Linux with Wayland first (developed on KDE Plasma), also X11, Windows and macOS.

## Supported languages

Bulgarian, Croatian, Czech, Danish, Dutch, English, Estonian, Finnish, French, German, Greek,
Hungarian, Italian, Latvian, Lithuanian, Maltese, Polish, Portuguese, Romanian, Russian,
Slovak, Slovenian, Spanish, Swedish, Ukrainian.

Pick the language you **speak** and the language to **write in**. If they're the same,
Chirp just transcribes; if they differ, it translates. Canary can't detect the spoken
language, so you have to choose it.

## Quick start (Linux)

Needs Node 22+, a Vulkan driver and `wl-clipboard` on Wayland.

```sh
git clone <this repo> chirp-stt && cd chirp-stt
npm install
npm run build && npm start      # or: npm run dev
```

On first start the settings window offers to **download the model** (1.14 GB) into
`~/.config/chirp-stt/models/`. You can also point it to a `.gguf` file you already have.
Loading takes a few seconds, and the first decode after launch takes up to ~15 s while the
GPU compiles its shaders. After that, a second of audio decodes in roughly 10 ms.

Then click into any text field, **hold Right Alt**, speak, and release.

### Permissions

Wayland doesn't let apps see global key presses, so Chirp reads the keyboard directly
through evdev. That needs the `input` group:

```sh
sudo usermod -aG input $USER    # then log out and back in
```

Pasting sends Ctrl+V from a virtual keyboard (`/dev/uinput`). Most systemd distros already
give the logged-in user access to it. If yours doesn't, add a udev rule or switch the
output to **Clipboard only**.

**Without the `input` group** Chirp falls back to the **desktop portal**
(xdg GlobalShortcuts). The first time, KDE and GNOME ask you to confirm a shortcut. The
default is **Ctrl+Space**; a lone Right Alt isn't possible there. As a last resort, bind
`chirp-stt --toggle` to any shortcut in your desktop settings: press it once to start
and again to stop.

## Usage

| Action | How |
| --- | --- |
| Dictate | Hold the hotkey (default **Right Alt**), speak, release |
| Cancel | Press any other key while holding the hotkey. AltGr chords such as AltGr+V → `@` keep working |
| Toggle mode | `chirp-stt --toggle` starts or stops dictation (bind it to a shortcut) |
| Open settings | Tray icon → Settings…, or launch with `--settings` |
| Switch languages | Tray icon → I speak / Write in / Swap languages |
| Copy an old result | Settings → History |

**Output modes:**
- **Paste:** copies the text to the clipboard, then sends the paste shortcut. The shortcut
  can be Ctrl+V, Ctrl+Shift+V (terminals) or Shift+Insert.
- **Clipboard only:** copies the text and leaves the pasting to you.

### Settings

| Setting | Default | Notes |
| --- | --- | --- |
| I speak / Write in | Hungarian → English | Same language on both sides = plain transcription |
| Hotkey backend | Auto | Auto on Linux: evdev, then portal. Elsewhere: uiohook |
| Hotkey | Right Alt | Any key for evdev and uiohook; a key combination for the portal |
| Cancel on chord | On | Pressing another key while holding cancels the recording |
| Output | Paste, Ctrl+V, trailing space | |
| Microphone | System default | |
| Launch at login | Off | |

Settings and history are stored in `~/.config/chirp-stt/` on Linux,
`%APPDATA%\chirp-stt\` on Windows and `~/Library/Application Support/chirp-stt/` on macOS.

## How it works

```
 hotkey (evdev / portal / uiohook)
        │ down / up
        ▼
 main process ── tray, windows, settings, history, paste (uinput / uiohook)
        │  ▲
  audio │  │ partial / final text
        ▼  │
 STT worker (Node.js child or utilityProcess) ── transcribe.cpp + Canary-1B-v2 on Vulkan
        ▲
        │ 16 kHz mono PCM (AudioWorklet)
 overlay window (mic capture + live text)
```

| Piece | Linux / Wayland | Windows / macOS / X11 |
| --- | --- | --- |
| Hold-to-talk key | evdev (`/dev/input`), falling back to the xdg GlobalShortcuts portal | uiohook |
| Paste | Clipboard via `wl-copy`, then Ctrl+V from a `/dev/uinput` virtual keyboard | Clipboard, then a uiohook key tap |
| Windows | Native Wayland; on KDE a KWin window rule keeps the overlay unfocusable, on top and at the bottom centre | Native |

**Live preview on a non-streaming model.** Canary isn't a streaming model, so while you
talk Chirp re-decodes the audio that isn't committed yet about every 800 ms. When you pause
(at least 500 ms of silence once a segment is 8 s or longer), the segment is decoded once
more, committed, and never decoded again. Continuous speech is force-cut at 25 s. This
keeps long dictations fast, and each decode costs only a few milliseconds on the GPU.

The model runs in a separate process, so a crash in native code can't take the UI down. Chirp
prefers to host it in a plain Node.js ≥ 22 runtime — the official Node binary bundled next to
the app in release builds, or the system `node` in dev — which also lifts Electron's allocator
limit so the CPU backend can load the full Q8_0 model; when no Node.js runtime is found it
falls back to Electron's `utilityProcess` and the smaller Q4_K_M model on CPU. Either way the
worker is restarted and the model reloaded automatically after a crash. The runtime can be
overridden with the `CHIRP_NODE` environment variable: set it to an absolute Node.js
executable path (an unusable path is an error, not a fallback), or to `0` to always use the
Electron utilityProcess.

## Troubleshooting

- **The tray icon is there but no window appears.** Chirp is a tray app and runs with no
  window open. Click the tray icon → Settings…. If a window opened behind your other
  windows (KDE's focus-stealing prevention), click it in the taskbar.
- **"Right Alt needs direct keyboard access" warning.** You're not in the `input` group yet (see
  [Permissions](#permissions)). Until then, the portal shortcut (Ctrl+Space) is used.
- **`npm start` / `npm run dev` exits with "already running".** Chirp allows only one
  instance; a second launch opens the settings of the one already running (check the tray).
  Quit it from the tray first if you want to run a fresh build.
- **Text is copied but not pasted.** Check `/dev/uinput` permissions, or try
  Ctrl+Shift+V as the paste shortcut (terminals).
- **Text is not pasted on Wayland.** Install `wl-clipboard`. Wayland only lets the
  focused app set the clipboard, and Chirp never has focus while you dictate, so it
  copies through `wl-copy`.
- **Paste lands nowhere / the overlay steals focus.** On KDE, Chirp adds a window rule
  "Chirp dictation overlay" (System Settings → Window Rules) that stops the overlay from taking
  focus. On other compositors Chirp hides the overlay before pasting so focus returns to your app.
- **Tray icon but no window, with `XGetWindowAttributes failed` in the log.** You're running
  under XWayland (`CHIRP_X11=1`), where Electron can fail to draw on some GPU drivers. Unset
  it to use native Wayland.
- **Status doesn't show "Vulkan0".** Vulkan wasn't found. Install your GPU's Vulkan driver
  (`vulkan-radeon`, `vulkan-intel` or `nvidia-utils`) and check with `vulkaninfo`.

## Development

```sh
npm run dev         # electron-vite with hot reload
npm run typecheck
npm test            # node:test, no Electron needed
```

Layout:

```
src/main/            main process: index.ts (orchestration, tray, windows, IPC)
  stt/               worker.ts (model), client.ts (worker IPC), dictation.ts (segmenting)
  input/             hotkey backends: evdev.ts, portal.ts, uiohook.ts, hotkey.ts (selection)
  output/            paster.ts, uinput.ts (virtual keyboard)
  settings.ts, history.ts, model-manager.ts, autostart.ts
src/preload/         window.chirp bridge
src/renderer/        overlay/ (mic capture + live text), settings/
src/shared/types.ts  shared types and IPC channel names
scripts/             manual checks: try-portal.ts, try-uinput.ts
test/                unit tests
```

## Packaging

```sh
npm run dist   # AppImage + deb on Linux, NSIS installer on Windows, dmg on macOS
```

Native modules (transcribe.cpp, koffi, uiohook-napi) are unpacked from the asar archive so
they can load, and so does the worker script (`out/main/stt-worker.js`) — a plain Node.js
child can't read inside the asar archive. A bundled Node.js ≥ 22 binary is shipped in
`<resources>/node/` so the speech engine can run outside Electron. The model is not bundled;
it's downloaded on first run.

## License

MIT. The Canary-1B-v2 model is licensed separately by NVIDIA (CC-BY-4.0).
