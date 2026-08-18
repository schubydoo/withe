/**
 * The palette meets WCAG 2.1 AA, read from the components rather than assumed
 * (B-3, NFR-18).
 *
 * "Amber on light is not amber on dark": the status colours are the risk this
 * guards. Earlier this file listed the foreground/background pairs by hand, so a
 * colour change in a `.tsx` left every test green and only editing the test could
 * fail it. Instead, scan `src/app/**` for the colour utility classes the app
 * actually renders, pair each text colour with the background it sits on, and
 * check the ratio the way WCAG defines it. A future class that dips below 4.5:1 —
 * or names a shade with no anchor here — fails in this test, not in the wild.
 *
 * Pairing rule, per element `className`:
 *   - a text colour written beside a background colour (a badge, the banner) is
 *     read on that background;
 *   - a text colour with no background beside it floats on the page background
 *     (`PAGE`), unless the file paints its own surface (`SURFACE`).
 * `hover:`/`focus:` backgrounds are transient and are not treated as the surface.
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
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

// Tailwind palette anchors (token → sRGB hex) for every shade the app renders.
// A class naming a token absent here fails the coverage test below with its name,
// which is the prompt to add the anchor rather than a silent skip.
const PALETTE: Record<string, string> = {
  white: '#ffffff',
  'neutral-50': '#fafafa',
  'neutral-100': '#f5f5f5',
  'neutral-200': '#e5e5e5',
  'neutral-300': '#d4d4d4',
  'neutral-400': '#a3a3a3',
  'neutral-500': '#737373',
  'neutral-600': '#525252',
  'neutral-700': '#404040',
  'neutral-800': '#262626',
  'neutral-900': '#171717',
  'neutral-950': '#0a0a0a',
  'red-50': '#fef2f2',
  'red-100': '#fee2e2',
  'red-200': '#fecaca',
  'red-300': '#fca5a5',
  'red-700': '#b91c1c',
  'red-800': '#991b1b',
  'red-900': '#7f1d1d',
  'red-950': '#450a0a',
  'amber-50': '#fffbeb',
  'amber-100': '#fef3c7',
  'amber-200': '#fde68a',
  'amber-300': '#fcd34d',
  'amber-700': '#b45309',
  'amber-800': '#92400e',
  'amber-900': '#78350f',
  'amber-950': '#451a03',
  'green-50': '#f0fdf4',
  'green-100': '#dcfce7',
  'green-200': '#bbf7d0',
  'green-300': '#86efac',
  'green-700': '#15803d',
  'green-800': '#166534',
  'green-900': '#14532d',
  'green-950': '#052e16',
  'blue-100': '#dbeafe',
  'blue-300': '#93c5fd',
  'blue-800': '#1e40af',
  'blue-900': '#1e3a8a',
  'purple-300': '#d8b4fe',
  'purple-700': '#9333ea',
};

// The background <body> paints per theme (layout.tsx: `bg-white dark:bg-neutral-950`).
const PAGE: Record<'light' | 'dark', string> = { light: 'white', dark: 'neutral-950' };

// Files that paint their own surface, so their floating text is not on the page
// background. Keyed by a path suffix. The log viewer wraps its lines in a
// neutral-50 / neutral-900 panel.
const SURFACE: { suffix: string; light: string; dark: string }[] = [
  { suffix: 'runs/[id]/log-viewer.tsx', light: 'neutral-50', dark: 'neutral-900' },
];

const here = fileURLToPath(new URL('.', import.meta.url));

function surfaceFor(file: string, theme: 'light' | 'dark'): string {
  const override = SURFACE.find((s) => file.endsWith(s.suffix));
  return override ? override[theme] : PAGE[theme];
}

function tsxFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...tsxFiles(full));
    else if (entry.name.endsWith('.tsx') && !entry.name.endsWith('.test.tsx')) out.push(full);
  }
  return out;
}

// A colour token: `white`, or a family with a shade (`neutral-500`, `red-300`).
const COLOR = 'white|black|(?:neutral|red|amber|green|blue|purple)-\\d{2,3}';
// Class utilities we read. Only the base (no variant) and `dark:` scopes matter;
// `hover:`/`focus:`/`group-*` backgrounds are transient, so they are left out by
// requiring the token to start the string (no other `x:` prefix before it).
const TEXT = new RegExp(`(?:^|\\s)(dark:)?text-(${COLOR})(?=\\s|$)`, 'g');
const BG = new RegExp(`(?:^|\\s)(dark:)?bg-(${COLOR})(?=\\s|$)`, 'g');

interface Pair {
  theme: 'light' | 'dark';
  fg: string;
  bg: string;
}

// Every string literal in the file is a candidate class list. Non-class strings
// carry no `text-<colour>` token, so they contribute nothing; ternary arms and
// lookup-table values (the log-level TONE map) are separate literals and are each
// read on their own.
function pairsFromFile(file: string): Pair[] {
  const src = readFileSync(file, 'utf8');
  const literals = src.match(/(['"`])(?:\\.|(?!\1)[^\\])*\1/g) ?? [];
  const pairs: Pair[] = [];
  for (const raw of literals) {
    const cls = raw.slice(1, -1).replace(/\$\{[^}]*\}/g, ' ');
    for (const theme of ['light', 'dark'] as const) {
      const want = theme === 'dark';
      const bg = [...cls.matchAll(BG)].find((m) => Boolean(m[1]) === want)?.[2];
      const texts = [...cls.matchAll(TEXT)]
        .filter((m) => Boolean(m[1]) === want)
        .map((m) => m[2])
        .filter((c): c is string => c !== undefined);
      for (const fg of texts) pairs.push({ theme, fg, bg: bg ?? surfaceFor(file, theme) });
    }
  }
  return pairs;
}

const all = tsxFiles(here).flatMap(pairsFromFile);
// One test per distinct pair; a Set keeps the output readable when a colour is
// used many times.
const distinct = new Map<string, Pair>();
for (const p of all) distinct.set(`${p.theme}:${p.fg}:${p.bg}`, p);

assert.ok(distinct.size > 0, 'the scan found no colour classes — the pairing regex or the path is wrong');

for (const p of distinct.values()) {
  test(`${p.theme}: text-${p.fg} on ${p.bg} meets WCAG AA`, () => {
    const fgHex = PALETTE[p.fg];
    const bgHex = PALETTE[p.bg];
    assert.ok(fgHex, `no palette anchor for text colour '${p.fg}' — add it to PALETTE`);
    assert.ok(bgHex, `no palette anchor for background '${p.bg}' — add it to PALETTE`);
    const r = ratio(fgHex, bgHex);
    assert.ok(r >= AA_NORMAL, `${p.theme} text-${p.fg} on ${p.bg}: ${r.toFixed(2)}:1 is below ${AA_NORMAL}:1`);
  });
}
