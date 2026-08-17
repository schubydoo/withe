/**
 * The palette meets WCAG 2.1 AA, checked rather than assumed (B-3, NFR-18).
 *
 * "Amber on light is not amber on dark": the status colours are the risk this
 * guards. Each pair below is a foreground the app renders on a background it
 * renders it on, in one theme or the other. The sRGB values are the Tailwind
 * palette anchors; the ratio is computed the way WCAG defines it, so a future
 * palette change that dips below 4.5:1 fails here instead of in the wild.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

const AA_NORMAL = 4.5;

function channel(v: number): number {
  const s = v / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

function luminance(hex: string): number {
  const n = Number.parseInt(hex.replace('#', ''), 16);
  const r = (n >> 16) & 0xff;
  const g = (n >> 8) & 0xff;
  const b = n & 0xff;
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function ratio(fg: string, bg: string): number {
  const a = luminance(fg);
  const b = luminance(bg);
  const [hi, lo] = a > b ? [a, b] : [b, a];
  return (hi + 0.05) / (lo + 0.05);
}

// Tailwind palette anchors used by the app.
const C = {
  white: '#ffffff',
  n100: '#f5f5f5',
  n300: '#d4d4d4',
  n400: '#a3a3a3',
  n500: '#737373',
  n600: '#525252',
  n900: '#171717',
  n950: '#0a0a0a',
  red50: '#fef2f2',
  red300: '#fca5a5',
  red800: '#991b1b',
  red950: '#450a0a',
  amber50: '#fffbeb',
  amber200: '#fde68a',
  amber300: '#fcd34d',
  amber900: '#78350f',
  amber950: '#451a03',
  green50: '#f0fdf4',
  green300: '#86efac',
  green800: '#166534',
  green950: '#052e16',
  blue100: '#dbeafe',
  blue300: '#93c5fd',
  blue800: '#1e40af',
  blue900: '#1e3a8a',
  purple300: '#d8b4fe',
};

const PAIRS: { name: string; fg: string; bg: string }[] = [
  // Light theme, page background white.
  { name: 'light body', fg: C.n900, bg: C.white },
  { name: 'light strong-muted', fg: C.n600, bg: C.white },
  { name: 'light muted', fg: C.n500, bg: C.white },
  { name: 'light amber banner', fg: C.amber900, bg: C.amber50 },
  { name: 'light red banner', fg: C.red800, bg: C.red50 },
  { name: 'light green banner', fg: C.green800, bg: C.green50 },
  { name: 'light blue badge', fg: C.blue800, bg: C.blue100 },
  // Dark theme, page background neutral-950.
  { name: 'dark body', fg: C.n100, bg: C.n950 },
  { name: 'dark strong-muted', fg: C.n300, bg: C.n950 },
  { name: 'dark muted', fg: C.n400, bg: C.n950 },
  { name: 'dark amber banner', fg: C.amber200, bg: C.amber950 },
  { name: 'dark red banner', fg: C.red300, bg: C.red950 },
  { name: 'dark green banner', fg: C.green300, bg: C.green950 },
  { name: 'dark blue badge', fg: C.blue300, bg: C.blue900 },
  // Dark log levels, which render on the page background.
  { name: 'dark log warn', fg: C.amber300, bg: C.n950 },
  { name: 'dark log error', fg: C.red300, bg: C.n950 },
  { name: 'dark log raw', fg: C.purple300, bg: C.n950 },
];

for (const pair of PAIRS) {
  test(`${pair.name} meets WCAG AA`, () => {
    const r = ratio(pair.fg, pair.bg);
    assert.ok(r >= AA_NORMAL, `${pair.name}: ${r.toFixed(2)}:1 is below ${AA_NORMAL}:1`);
  });
}
