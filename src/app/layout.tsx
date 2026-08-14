import type { Metadata } from 'next';
import './globals.css';
import { exposureWarning } from '../config/exposure.ts';
import { loadConfig } from '../config/load.ts';

export const metadata: Metadata = {
  title: 'Withe',
  description: 'A dashboard for the Renovate you already run.',
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  // NFR-13b. The same sentence the supervisor prints at startup, on every page,
  // because the startup line scrolls away and this does not.
  const config = loadConfig();
  const warning = exposureWarning(config.bind, config.auth !== null);

  return (
    <html lang="en">
      <body className="bg-white text-neutral-900">
        {warning && (
          <p
            role="alert"
            className="border-b border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-900"
          >
            {warning}
          </p>
        )}
        {children}
      </body>
    </html>
  );
}
