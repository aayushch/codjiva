// Applies the colour theme of the app's own window.
//
// The theme is the `theme` setting: `light`, `dark`, or `system` to follow the operating
// system. The style sheets read it from the `data-theme` attribute of the page's root element,
// which is always `light` or `dark`.

import { api } from '$lib/ipc';

export type ThemeSetting = 'system' | 'light' | 'dark';

// Where the setting is also kept in the browser's storage. The settings file is read after the
// page is drawn, so `applyStoredTheme` uses this copy to draw the first frame in the right
// colours.
const STORAGE_KEY = 'codjiva.theme';

const systemIsLight = () => window.matchMedia('(prefers-color-scheme: light)').matches;

// Sets the page and the window to the theme the setting asks for.
export function applyTheme(setting: ThemeSetting) {
  document.documentElement.dataset.theme = setting === 'system' ? (systemIsLight() ? 'light' : 'dark') : setting;
  try {
    localStorage.setItem(STORAGE_KEY, setting);
  } catch {
    // Without storage the next start is drawn dark first and corrected when settings load.
  }
  // The window's own theme decides the look of what the operating system draws, such as the
  // list a drop-down opens. `null` hands the choice back to the operating system.
  api.setWindowTheme(setting === 'system' ? null : setting).catch(() => {});
}

// Applies the theme that was in use when the app last ran. Called before the interface is
// mounted.
export function applyStoredTheme() {
  let stored: string | null = null;
  try {
    stored = localStorage.getItem(STORAGE_KEY);
  } catch {
    // Treated as no stored theme.
  }
  const setting: ThemeSetting = stored === 'light' || stored === 'dark' ? stored : 'system';
  document.documentElement.dataset.theme = setting === 'system' ? (systemIsLight() ? 'light' : 'dark') : setting;
}

// Calls `changed` whenever the operating system switches between light and dark. Returns a
// function that stops the calls.
export function onSystemThemeChange(changed: () => void): () => void {
  const query = window.matchMedia('(prefers-color-scheme: light)');
  query.addEventListener('change', changed);
  return () => query.removeEventListener('change', changed);
}
