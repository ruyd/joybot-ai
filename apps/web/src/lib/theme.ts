import { useSyncExternalStore } from 'react';

/** Light/dark theme: follows the system until the viewer picks one (kept in this browser only). */
export type ThemePreference = 'system' | 'light' | 'dark';

const KEY = 'joybot.theme';
const media = typeof window !== 'undefined' ? window.matchMedia('(prefers-color-scheme: dark)') : null;
const listeners = new Set<() => void>();

function read(): ThemePreference {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'light' || v === 'dark' ? v : 'system';
  } catch {
    return 'system';
  }
}

let preference = read();

function isDark(p: ThemePreference) {
  return p === 'dark' || (p === 'system' && !!media?.matches);
}

function apply() {
  const dark = isDark(preference);
  document.documentElement.classList.toggle('dark', dark);
  document.documentElement.style.colorScheme = dark ? 'dark' : 'light';
  listeners.forEach((l) => l());
}

media?.addEventListener('change', () => {
  if (preference === 'system') apply();
});

export function setTheme(p: ThemePreference) {
  preference = p;
  try {
    if (p === 'system') localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, p);
  } catch {
    // storage unavailable: the choice lasts until the page reloads
  }
  apply();
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};
const snapshot = () => `${preference}:${isDark(preference) ? 'dark' : 'light'}`;

export function useTheme() {
  const [pref, resolved] = useSyncExternalStore(subscribe, snapshot).split(':') as [ThemePreference, 'light' | 'dark'];
  return { preference: pref, resolved, setTheme };
}
