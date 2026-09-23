import type { ChirpApi } from "../preload/index.ts";

declare global {
  interface Window {
    chirp: ChirpApi;
  }
}
