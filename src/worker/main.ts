/**
 * The sync worker.
 *
 * Runs a cycle on a timer, or once and exits with `--once`. The supervised
 * two-process arrangement is Task 2.2; this is still started by hand.
 */
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';

import '../adapters/ce/adapter.ts';
import { createAdapter } from '../adapters/registry.ts';
import { openDatabase } from '../db/client.ts';
import { SyncLoop } from './sync.ts';

const url = process.env.WITHE_CE_URL;
const token = process.env.WITHE_CE_TOKEN;
const id = process.env.WITHE_SOURCE_ID ?? 'ce';
const file = process.env.WITHE_DB_PATH ?? './withe.db';
const once = process.argv.includes('--once');

const DAY_MS = 24 * 60 * 60 * 1000;
const intervalSeconds = positive(process.env.WITHE_SYNC_INTERVAL_SECONDS, 300);
const stalledAfterDays = positive(process.env.WITHE_STALLED_AFTER_DAYS, 7);

/** Reject a setting that would busy-loop or disable a safeguard silently. */
function positive(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    console.error(`'${raw}' is not a positive number.`);
    process.exit(2);
  }
  return value;
}

if (!url || !token) {
  console.error('Set WITHE_CE_URL and WITHE_CE_TOKEN.');
  process.exit(2);
}

// TEMPORARY(org-discovery). See SourceConfig.orgs and tad.md Section 7.7.2.
const orgs = process.env.WITHE_CE_ORGS?.split(',')
  .map((name) => name.trim())
  .filter((name) => name.length > 0);

const { sqlite, db } = openDatabase(file);
migrate(db, { migrationsFolder: './drizzle' });

const adapter = createAdapter({ id, kind: 'ce', url, token, orgs });

const preflight = await adapter.preflight();
for (const problem of preflight.problems) {
  const where = problem.setting ? ` (${problem.setting})` : '';
  console.error(`preflight ${problem.probe}: ${problem.detail}${where}`);
}
if (!preflight.ok) {
  sqlite.close();
  process.exit(1);
}
if (preflight.reachableButEmpty) {
  console.warn('The server is reachable and has no repositories onboarded.');
}

const loop = new SyncLoop(db, [adapter], {
  intervalMs: intervalSeconds * 1000,
  stalledAfterMs: stalledAfterDays * DAY_MS,
});

function report(prefix: string, outcomes: { sourceAdapterId: string; outcome: string; repos: number; runs: number; updates: number }[]) {
  for (const o of outcomes) {
    console.log(`${prefix} ${o.sourceAdapterId}: ${o.outcome} — ${o.repos} repositories, ${o.runs} runs, ${o.updates} updates`);
  }
}

const first = await loop.runCycle();
report('synced', first.sources);

if (once) {
  sqlite.close();
} else {
  console.log(`watching ${file}, syncing every ${intervalSeconds}s. Ctrl-C to stop.`);
  loop.start();

  // Without this the unref'd timer would let the process exit immediately.
  const keepAlive = setInterval(() => {}, 1 << 30);

  const shutdown = (signal: string) => {
    console.log(`\n${signal}: stopping after the current cycle.`);
    loop.stop();
    clearInterval(keepAlive);
    sqlite.close();
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}
