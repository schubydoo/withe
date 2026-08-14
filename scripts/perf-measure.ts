/**
 * Measure the performance NFRs, method fixed before any number (Task 3.8).
 *
 * The method, stated once so the numbers mean something:
 *
 * - Sample size is 100 for every latency figure.
 * - Page timing is the loopback response time of the standalone server — send
 *   request to full body received — which on localhost is server render with a
 *   sub-millisecond transfer, and no browser, so it is neither TTFB over a
 *   network nor LCP. Data pages set `dynamic = 'force-dynamic'` (tad.md 8.2),
 *   so there is no cache to warm; this is the steady state after a warm-up
 *   request, which is discarded.
 * - Log render is the CPU the viewer spends before first paint — `parseLines`
 *   then `applyFilter` over 5,000 lines — with no upstream fetch, because the
 *   CE server's latency is not a property of Withe.
 * - Datasets are generated (scripts/perf-dataset.ts) because the author's fleet
 *   is 8 repositories and NFR-2 asks for 500.
 *
 * Memory (NFR-5), cold start (NFR-7) and image size (NFR-6) are measured
 * against the arm64 container and recorded in docs/performance.md; they are not
 * in this script because they need the image, not the source.
 *
 *   npm run build && npm run perf
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';

import { applyFilter, parseLines } from '../src/core/log-lines.ts';
import { generate } from './perf-dataset.ts';

const N = 100;
const PORT = 31_355;
const NOW = 1_786_000_000_000;
const work = mkdtempSync(join(tmpdir(), 'withe-perf-'));

interface Stats {
  p50: number;
  p95: number;
  max: number;
}

function stats(samples: number[]): Stats {
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (q: number): number =>
    sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] ?? 0;
  return { p50: at(0.5), p95: at(0.95), max: at(1) };
}

function ms(n: number): string {
  return `${n.toFixed(1)} ms`;
}

function line(label: string, s: Stats, budget: number): string {
  const ok = s.p95 <= budget ? 'ok  ' : 'FAIL';
  return `${ok}  ${label}: p50 ${ms(s.p50)}, p95 ${ms(s.p95)}, max ${ms(s.max)} (budget p95 ${budget} ms)`;
}

async function waitForServer(): Promise<void> {
  for (let i = 0; i < 100; i += 1) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/api/health`);
      if (r.status === 200 || r.status === 503) return;
    } catch {
      /* not up */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('server did not start');
}

function startServer(dbPath: string): ChildProcess {
  return spawn(process.execPath, ['server.js'], {
    cwd: '.next/standalone',
    stdio: 'ignore',
    env: {
      ...process.env,
      WITHE_DB_PATH: dbPath,
      WITHE_CONFIG: join(work, 'none.yaml'),
      WITHE_CE_URL: 'http://127.0.0.1:1',
      WITHE_CE_TOKEN: 'perf',
      HOSTNAME: '127.0.0.1',
      PORT: String(PORT),
    },
  });
}

/** Time N loopback GETs of one path, discarding a warm-up. */
async function timePage(path: string): Promise<Stats> {
  await fetch(`http://127.0.0.1:${PORT}${path}`);
  const samples: number[] = [];
  for (let i = 0; i < N; i += 1) {
    const t = performance.now();
    const response = await fetch(`http://127.0.0.1:${PORT}${path}`);
    await response.text();
    samples.push(performance.now() - t);
  }
  return stats(samples);
}

async function measurePage(label: string, repoCount: number, budget: number): Promise<string> {
  const dbPath = join(work, `perf${repoCount}.db`);
  generate(dbPath, repoCount, NOW);
  const server = startServer(dbPath);
  try {
    await waitForServer();
    const s = await timePage('/');
    return line(`${label} landing page, ${repoCount} repos`, s, budget);
  } finally {
    server.kill('SIGTERM');
    await once(server, 'exit');
  }
}

/** A 5,000-line Renovate-shaped log: bunyan JSON, a tenth at warn or error. */
function syntheticLog(lines: number): string {
  const levels = [30, 30, 30, 30, 30, 30, 30, 40, 40, 50];
  const out: string[] = [];
  for (let i = 0; i < lines; i += 1) {
    out.push(
      JSON.stringify({
        level: levels[i % levels.length],
        time: new Date(NOW - (lines - i) * 1000).toISOString(),
        msg: `processing dependency @scope/package-${i % 200} from datasource npm, comparing 1.${i % 40}.0 to 1.${i % 40}.1`,
        name: 'renovate',
      }),
    );
  }
  return out.join('\n');
}

function measureLogRender(): string {
  const text = syntheticLog(5000);
  fromWarmUp(text);
  const samples: number[] = [];
  for (let i = 0; i < N; i += 1) {
    const t = performance.now();
    const parsed = parseLines(text);
    applyFilter(parsed.lines, { levels: ['warn', 'error'], search: 'package-1' });
    samples.push(performance.now() - t);
  }
  return line('log render, 5,000 lines (parse + filter, no fetch)', stats(samples), 1000);
}

function fromWarmUp(text: string): void {
  const parsed = parseLines(text);
  applyFilter(parsed.lines, { levels: [], search: '' });
}

function measureSyncWrite(): string {
  // The write half of a sync: 50 repositories with their runs and updates,
  // straight to disk. The read half is CE's latency, anchored live below.
  const path = join(work, 'syncwrite.db');
  const t = performance.now();
  generate(path, 50, NOW);
  const elapsed = performance.now() - t;
  const ok = elapsed <= 60_000 ? 'ok  ' : 'FAIL';
  return `${ok}  sync write, 50 repos (Withe-side, no CE fetch): ${ms(elapsed)} (budget 60,000 ms; live 8-repo end-to-end cycle is ~1 s, fetch-bound)`;
}

const results: string[] = [];
try {
  results.push(await measurePage('NFR-1', 50, 400));
  results.push(await measurePage('NFR-2', 500, 1200));
  results.push(measureLogRender());
  results.push(measureSyncWrite());
} finally {
  rmSync(work, { recursive: true, force: true });
}

console.log('\n--- Task 3.8 performance, source-measurable NFRs ---\n');
for (const r of results) console.log(r);
console.log('\nNFR-5 (memory), NFR-6 (image size) and NFR-7 (cold start) are container measurements — see docs/performance.md.');

if (results.some((r) => r.startsWith('FAIL'))) process.exitCode = 1;
