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
          // Full-width bar, but the text sits in a centered, padded column
          // rather than hard against the window edge (B-8). The pages below use
          // no single width, so align to the dashboard (`max-w-4xl`), the page a
          // reader sees first and most.
          <div role="alert" className="border-b border-amber-200 bg-amber-50 text-amber-900">
            <p className="mx-auto max-w-4xl px-8 py-2 text-sm">{warning}</p>
          </div>
        )}
        {children}
      </body>
    </html>
  );
}
