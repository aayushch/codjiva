import { mockApi } from './mock';
import { tauriApi } from './tauri';
import type { Api } from './types';

// True inside the desktop app, false when the interface runs in a plain
// browser.
export const inDesktopApp =
  typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

export const api: Api = inDesktopApp ? tauriApi : mockApi;

export type * from './types';
