import type { Metadata } from 'next';
import './globals.css';
import { exposureWarning } from '../config/exposure.ts';
import { loadConfig } from '../config/load.ts';
import { StalenessBanner } from './staleness-banner.tsx';
import { ThemeToggle } from './theme-toggle.tsx';

export const metadata: Metadata = {
  title: 'Withe',
  description: 'A dashboard for the Renovate you already run.',
};

// Runs before the first paint so the page opens in the saved theme with no flash
// of the wrong one. It mirrors resolveDark in theme.ts, resolving every value the
// same way the toggle does: 'dark' is dark, 'light' is light, and everything else
// — 'system', a missing key, or an unrecognised value the toggle would normalise
// to 'system' — follows the OS. Keep them in step.
const THEME_SCRIPT = `(function(){try{var p=localStorage.getItem('withe-theme');var d=p==='dark'||(p!=='light'&&window.matchMedia('(prefers-color-scheme: dark)').matches);document.documentElement.classList.toggle('dark',d);}catch(e){}})();`;

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  // NFR-13b. The same sentence the supervisor prints at startup, on every page,
  // because the startup line scrolls away and this does not.
  const config = loadConfig();
  const warning = exposureWarning(config.bind, config.auth !== null, config.exposureAcknowledged);

  return (
    <html lang="en" suppressHydrationWarning>
      <body className="bg-white dark:bg-neutral-950 text-neutral-900 dark:text-neutral-100">
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
        <ThemeToggle />
        {warning && (
          // Full-width bar, but the text sits in a centered, padded column
          // rather than hard against the window edge (B-8). The pages below use
          // no single width, so align to the dashboard (`max-w-4xl`), the page a
          // reader sees first and most.
          <div
            role="alert"
            className="border-b border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-950 text-amber-900 dark:text-amber-200"
          >
            <p className="mx-auto max-w-4xl px-8 py-2 text-sm">{warning}</p>
          </div>
        )}
        <StalenessBanner />
        {children}
      </body>
    </html>
  );
}
