import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Withe',
  description: 'A dashboard for the Renovate you already run.',
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className="bg-white text-neutral-900">{children}</body>
    </html>
  );
}
