import { app } from "electron";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Electron's login-item API only covers Windows/macOS; on Linux use an XDG autostart entry.
export function setAutostart(enabled: boolean) {
  if (process.platform !== "linux") {
    app.setLoginItemSettings({ openAtLogin: enabled });
    return;
  }
  const dir = join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "autostart");
  const file = join(dir, "chirp-stt.desktop");
  if (!enabled) {
    rmSync(file, { force: true });
    return;
  }
  // AppImages run from a temp mount; APPIMAGE holds the real path.
  const exec = process.env.APPIMAGE || process.execPath;
  const args = app.isPackaged ? "" : ` ${JSON.stringify(app.getAppPath())}`;
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    file,
    [
      "[Desktop Entry]",
      "Type=Application",
      "Name=Chirp",
      "Comment=Hold-to-talk speech-to-text",
      `Exec=${JSON.stringify(exec)}${args}`,
      "Icon=chirp-stt",
      "X-GNOME-Autostart-enabled=true",
      "",
    ].join("\n"),
  );
}

export const LINUX_APP_ID = "com.chirp.stt";

/**
 * Installs ~/.local/share/applications/com.chirp.stt.desktop so the desktop
 * portal can resolve our app id (needed for GlobalShortcuts) and the app
 * shows up in launchers. Packaged installs ship their own entry, but this
 * one is harmless and keeps dev builds working.
 */
export function ensureDesktopEntry() {
  if (process.platform !== "linux") return;
  const dir = join(process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "applications");
  const exec = process.env.APPIMAGE || process.execPath;
  const args = app.isPackaged ? "" : ` ${JSON.stringify(app.getAppPath())}`;
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${LINUX_APP_ID}.desktop`),
    [
      "[Desktop Entry]",
      "Type=Application",
      "Name=Chirp",
      "Comment=Hold-to-talk speech-to-text and translation",
      `Exec=${JSON.stringify(exec)}${args} %U`,
      "Icon=chirp-stt",
      "Categories=Utility;Accessibility;",
      "StartupWMClass=chirp-stt",
      "",
    ].join("\n"),
  );
}
