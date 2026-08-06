/**
 * The sync worker.
 *
 * Runs a cycle on a timer, or once and exits with `--once`. Configuration is
 * loaded once here rather than read from the environment where it is used, so
 * a mistake is reported at startup with the field named.
 */
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';

import '../adapters/ce/adapter.ts';
import { createAdapter } from '../adapters/registry.ts';
import type { SourceAdapter } from '../adapters/types.ts';
import { ConfigError, loadConfig } from '../config/load.ts';
import { openDatabase } from '../db/client.ts';
import { SyncLoop } from './sync.ts';

const DAY_MS = 24 * 60 * 60 * 1000;
const once = process.argv.includes('--once');

const config = (() => {
  try {
    return loadConfig();
  } catch (cause) {
    if (cause instanceof ConfigError) {
      console.error(`configuration: ${cause.message}`);
      process.exit(2);
    }
    throw cause;
  }
})();

for (const warning of config.warnings) console.warn(`configuration: ${warning}`);

if (config.sources.length === 0) {
  console.error('No sources are configured. Set WITHE_CE_URL and WITHE_CE_TOKEN, or write a config file.');
  process.exit(2);
}

const { sqlite, db } = openDatabase(config.dbPath);
migrate(db, { migrationsFolder: './drizzle' });

const adapters: SourceAdapter[] = config.sources.map((source) => createAdapter(source));

// Preflight every source, but let a working one run even when another is
// broken. Refusing to start because the second of three servers is down would
// hide the two that work.
const usable: SourceAdapter[] = [];
for (const adapter of adapters) {
  const preflight = await adapter.preflight();
  for (const problem of preflight.problems) {
    const where = problem.setting ? ` (${problem.setting})` : '';
    console.error(`preflight ${adapter.id}/${problem.probe}: ${problem.detail}${where}`);
  }
  if (preflight.reachableButEmpty) {
    console.warn(`preflight ${adapter.id}: reachable, with no repositories onboarded.`);
  }
  if (preflight.ok) usable.push(adapter);
}

if (usable.length === 0) {
  sqlite.close();
  process.exit(1);
}

const loop = new SyncLoop(db, usable, {
  intervalMs: config.syncIntervalSeconds * 1000,
  stalledAfterMs: config.stalledAfterDays * DAY_MS,
});

const first = await loop.runCycle();
for (const outcome of first.sources) {
  console.log(
    `synced ${outcome.sourceAdapterId}: ${outcome.outcome} — ` +
      `${outcome.repos} repositories, ${outcome.runs} runs, ${outcome.updates} updates`,
  );
}

if (once) {
  sqlite.close();
} else {
  console.log(`watching ${config.dbPath}, syncing every ${config.syncIntervalSeconds}s. Ctrl-C to stop.`);
  loop.start();

  // Without this the unref'd interval would let the process exit immediately.
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
