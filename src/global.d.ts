import type { MultiServiceConsoleApi } from '../electron/preload';

declare global {
  interface Window {
    serviceConsole: MultiServiceConsoleApi;
  }
}

export {};
