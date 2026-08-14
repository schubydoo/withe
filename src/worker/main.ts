/**
 * The sync worker.
 *
 * Runs a cycle on a timer, or once and exits with `--once`. Configuration is
 * loaded once here rather than read from the environment where it is used, so
 * a mistake is reported at startup with the field named.
 */
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';

import { createAdapter } from '../adapters/register.ts';
import type { SourceAdapter } from '../adapters/types.ts';
import { ConfigError, loadConfig } from '../config/load.ts';
import { installRedaction, secretsFrom } from '../core/redact.ts';
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

// NFR-12, before the first line this process writes about a source. Everything
// above logs field names only; everything below can carry an upstream message.
installRedaction(secretsFrom(config));

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
  try {
    const preflight = await adapter.preflight();
    for (const problem of preflight.problems) {
      const where = problem.setting ? ` (${problem.setting})` : '';
      console.error(`preflight ${adapter.id}/${problem.probe}: ${problem.detail}${where}`);
    }
    if (preflight.reachableButEmpty) {
      console.warn(`preflight ${adapter.id}: reachable, with no repositories onboarded.`);
    }
    if (preflight.ok) usable.push(adapter);
  } catch (cause) {
    // A server that refuses the connection makes preflight throw rather than
    // report. Unguarded, that ends the process — and under the supervisor,
    // three of those in a row take the whole container down with it.
    console.error(
      `preflight ${adapter.id}: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
}

// A source that is down at startup is not a reason to exit. The dashboard
// stays up, the preflight page says what is wrong, and the sync loop retries
// with its own backoff. Exiting here made an unreachable server look like a
// broken Withe: the container crash-looped instead of explaining itself.
const toSync = usable.length > 0 ? usable : adapters;

const loop = new SyncLoop(db, toSync, {
  intervalMs: config.syncIntervalSeconds * 1000,
  stalledAfterMs: config.stalledAfterDays * DAY_MS,
  secrets: secretsFrom(config),
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
