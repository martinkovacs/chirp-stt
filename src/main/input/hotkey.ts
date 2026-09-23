import type { Settings } from "../../shared/types.ts";
import type { HotkeySource } from "./types.ts";
import { EvdevHotkeySource } from "./evdev.ts";
import { UiohookHotkeySource } from "./uiohook.ts";

function isWaylandSession(): boolean {
  return process.env.XDG_SESSION_TYPE === "wayland" || !!process.env.WAYLAND_DISPLAY;
}

function isLinux(): boolean {
  return process.platform === "linux";
}

/**
 * Create and start a hotkey source according to settings.hotkeyBackend.
 *
 * - 'evdev' | 'portal' | 'uiohook': use exactly that backend (start errors propagate).
 * - 'auto': on Linux Wayland try evdev first, falling back to the portal (warning
 *   recorded on failure); on Linux X11 / Windows / macOS use uiohook
 *   (which does not work on native Wayland).
 * Backend selection may also be shared with the portal implementation.
 */
export async function createHotkeySource(
  settings: Settings,
  opts: { portalFactory: () => HotkeySource },
): Promise<{ source: HotkeySource; warnings: string[] }> {
  const warnings: string[] = [];
  const backend = settings.hotkeyBackend;

  if (backend === "evdev") {
    const source = new EvdevHotkeySource({ key: settings.evdevKey });
    await source.start();
    return { source, warnings };
  }
  if (backend === "portal") {
    const source = opts.portalFactory();
    await source.start();
    return { source, warnings };
  }
  if (backend === "uiohook") {
    const source = new UiohookHotkeySource({ key: settings.uiohookKey });
    await source.start();
    return { source, warnings };
  }

  // auto
  if (isLinux()) {
    if (isWaylandSession()) {
      try {
        const source = new EvdevHotkeySource({ key: settings.evdevKey });
        await source.start();
        return { source, warnings };
      } catch (err) {
        warnings.push(
          `evdev hotkey backend failed (${err instanceof Error ? err.message : String(err)}); ` +
            `falling back to the global shortcuts portal`,
        );
      }
      const source = opts.portalFactory();
      try {
        await source.start();
      } catch (err) {
        // Surface both failures: the evdev one is usually the actionable one.
        throw new Error(`${warnings.join(" ")} Portal: ${err instanceof Error ? err.message : String(err)}`);
      }
      return { source, warnings };
    }
    // X11
    const source = new UiohookHotkeySource({ key: settings.uiohookKey });
    await source.start();
    return { source, warnings };
  }

  // macOS / Windows
  const source = new UiohookHotkeySource({ key: settings.uiohookKey });
  await source.start();
  return { source, warnings };
}
