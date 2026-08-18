'use client';

import { useEffect, useState } from 'react';

import { isThemePreference, resolveDark, THEME_KEY, type ThemePreference } from './theme.ts';

const OPTIONS: { value: ThemePreference; label: string }[] = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
];

/** Set the `dark` class from a preference and the current OS setting. */
function apply(preference: ThemePreference) {
  const systemPrefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  document.documentElement.classList.toggle('dark', resolveDark(preference, systemPrefersDark));
}

/**
 * A three-way theme control shown on every page (B-3). The choice is named in
 * words — System, Light, Dark — never by colour alone, and it survives a reload
 * in localStorage. The pre-paint script in the layout reads the same key, so the
 * page opens in the right theme with no flash.
 */
export function ThemeToggle() {
  const [preference, setPreference] = useState<ThemePreference>('system');
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    let stored: string | null = null;
    try {
      stored = localStorage.getItem(THEME_KEY);
    } catch {
      // A browser that refuses storage still follows the OS for this page.
    }
    setPreference(isThemePreference(stored) ? stored : 'system');
    setMounted(true);
  }, []);

  // Keep following the operating system while the choice is "system".
  useEffect(() => {
    if (preference !== 'system') return;
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => apply('system');
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, [preference]);

  function choose(next: ThemePreference) {
    setPreference(next);
    try {
      localStorage.setItem(THEME_KEY, next);
    } catch {
      // A browser that refuses storage still gets the theme for this page.
    }
    apply(next);
  }

  return (
    <div
      role="group"
      aria-label="Colour theme"
      className="fixed right-3 bottom-3 z-10 flex overflow-hidden rounded border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-900 text-xs shadow-sm"
    >
      {OPTIONS.map((option) => {
        const active = mounted && preference === option.value;
        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={active}
            onClick={() => choose(option.value)}
            className={
              active
                ? 'px-2 py-1 bg-neutral-800 text-white dark:bg-neutral-200 dark:text-neutral-900'
                : 'px-2 py-1 text-neutral-600 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-800'
            }
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
