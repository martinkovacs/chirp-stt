import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import { IPC } from "../shared/types.ts";
import type { AppStatus, HistoryEntry, OverlayState, Settings } from "../shared/types.ts";

export interface HotkeyInfo {
  kind: string;
  label: string;
  warnings: string[];
}

function on<T extends unknown[]>(channel: string, cb: (...args: T) => void): () => void {
  const listener = (_e: IpcRendererEvent, ...args: unknown[]) => cb(...(args as T));
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

const api = {
  platform: process.platform,
  getSettings: (): Promise<Settings> => ipcRenderer.invoke(IPC.getSettings),
  setSettings: (patch: Partial<Settings>): Promise<Settings> => ipcRenderer.invoke(IPC.setSettings, patch),
  getStatus: (): Promise<AppStatus> => ipcRenderer.invoke(IPC.getStatus),
  getHistory: (): Promise<HistoryEntry[]> => ipcRenderer.invoke(IPC.getHistory),
  getHotkeyInfo: (): Promise<HotkeyInfo> => ipcRenderer.invoke(IPC.hotkeyInfo),
  downloadModel: (): Promise<void> => ipcRenderer.invoke(IPC.downloadModel),
  pickModel: (): Promise<string | null> => ipcRenderer.invoke(IPC.pickModel),
  copyText: (text: string): Promise<void> => ipcRenderer.invoke(IPC.copyText, text),

  onStatus: (cb: (s: AppStatus) => void) => on<[AppStatus]>(IPC.status, cb),
  onSettings: (cb: (s: Settings) => void) => on<[Settings]>(IPC.settingsChanged, cb),
  onHistory: (cb: (h: HistoryEntry[]) => void) => on<[HistoryEntry[]]>(IPC.historyChanged, cb),
  onOverlay: (cb: (s: OverlayState) => void) => on<[OverlayState]>(IPC.overlay, cb),
  onHotkeyInfo: (cb: (h: HotkeyInfo) => void) => on<[HotkeyInfo]>(IPC.hotkeyInfo, cb),

  // Audio capture lives in the overlay renderer; main tells it when to run.
  onCaptureStart: (cb: (micDeviceId: string) => void) => on<[string]>(IPC.captureStart, cb),
  onCaptureStop: (cb: () => void) => on<[]>(IPC.captureStop, cb),
  sendAudio: (pcm: Float32Array, level: number) => ipcRenderer.send(IPC.audioChunk, pcm, level),
  sendCaptureError: (message: string) => ipcRenderer.send(IPC.captureError, message),
};

export type ChirpApi = typeof api;

contextBridge.exposeInMainWorld("chirp", api);
