/**
 * The colour-theme choice (B-3).
 *
 * Three preferences: follow the operating system, or force light or dark. The
 * resolution is pure so it can be tested, and it is shared by the toggle and the
 * pre-paint script that sets the theme before the first frame.
 */
export type ThemePreference = 'system' | 'light' | 'dark';

/** The localStorage key the preference is stored under. */
export const THEME_KEY = 'withe-theme';

export function isThemePreference(value: unknown): value is ThemePreference {
  return value === 'system' || value === 'light' || value === 'dark';
}

/** Whether the dark theme applies, given a preference and the OS setting. */
export function resolveDark(preference: ThemePreference, systemPrefersDark: boolean): boolean {
  if (preference === 'dark') return true;
  if (preference === 'light') return false;
  return systemPrefersDark;
}
