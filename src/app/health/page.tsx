/**
 * What Withe knows about itself (Task 3.6).
 *
 * Written for the two moments it is read: a dashboard that looks stale, and a
 * bug report that needs the version of the schema it was filed against.
 */
import { existsSync, statSync } from 'node:fs';

import { loadConfig } from '../../config/load.ts';
import { assess } from '../../core/health.ts';
import { openDatabase } from '../../db/client.ts';
import { migrationState, sourceHealth, type MigrationState, type SourceHealth } from '../../db/queries.ts';
import { ago } from '../format.ts';

export const dynamic = 'force-dynamic';

const DAY_MS = 24 * 60 * 60 * 1000;

interface Report {
  sources: SourceHealth[];
  migrations: MigrationState;
  databaseBytes: number | null;
  intervalSeconds: number;
}

function read(): Report {
  const config = loadConfig();
  if (!existsSync(config.dbPath)) {
    return { sources: [], migrations: { applied: 0, newestAt: null }, databaseBytes: null, intervalSeconds: config.syncIntervalSeconds };
  }

  const { sqlite, db } = openDatabase(config.dbPath);
  try {
    return {
      sources: sourceHealth(db, new Date(Date.now() - DAY_MS)),
      migrations: migrationState(db),
      databaseBytes: statSync(config.dbPath).size,
      intervalSeconds: config.syncIntervalSeconds,
    };
  } finally {
    sqlite.close();
  }
}

function size(bytes: number | null): string {
  if (bytes === null) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} kB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function duration(seconds: number | null): string {
  if (seconds === null) return '—';
  return seconds < 1 ? 'under a second' : `${seconds}s`;
}

export default function HealthPage() {
  const { sources, migrations, databaseBytes, intervalSeconds } = read();
  const health = assess(sources, intervalSeconds);

  // NFR-18: the state is a word first. The colour repeats it, never replaces it.
  const tone =
    health.status === 'ok'
      ? 'bg-green-100 dark:bg-green-900 text-green-800 dark:text-green-300'
      : health.status === 'stale'
        ? 'bg-red-100 dark:bg-red-900 text-red-800 dark:text-red-300'
        : 'bg-amber-100 dark:bg-amber-900 text-amber-900 dark:text-amber-200';
  const summary =
    health.status === 'ok'
      ? `Syncing. Freshest data is ${health.ageSeconds === null ? 'unknown' : `${Math.round(health.ageSeconds / 60)} minutes`} old.`
      : health.status === 'stale'
        ? `Stale. Nothing has synced in over ${Math.round((intervalSeconds * 3) / 60)} minutes: ${health.stale.join(', ')}.`
        : 'No source has synced yet. The preflight page says why.';

  return (
    <main className="mx-auto max-w-5xl p-8">
      <h1 className="text-2xl font-semibold">Health</h1>
      <p className="mt-3">
        <span className={`rounded px-1.5 py-0.5 text-sm ${tone}`}>{health.status}</span>
        <span className="ml-2 text-sm text-neutral-600 dark:text-neutral-300">{summary}</span>
      </p>

      <section className="mt-8">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-neutral-500 dark:text-neutral-400">Sources</h2>
        {sources.length === 0 ? (
          <p className="mt-2 text-sm text-neutral-500 dark:text-neutral-400">
            No source has been recorded yet. <a className="underline" href="/preflight">Check the setup</a>.
          </p>
        ) : (
          <table className="mt-2 w-full text-sm">
            <caption className="sr-only">Every configured source, with its most recent sync.</caption>
            <thead>
              <tr className="border-b border-neutral-300 dark:border-neutral-700 text-left text-xs uppercase tracking-wide text-neutral-500 dark:text-neutral-400">
                <th scope="col" className="py-2 pr-4 font-medium">Source</th>
                <th scope="col" className="py-2 pr-4 font-medium">Last success</th>
                <th scope="col" className="py-2 pr-4 font-medium">Last attempt</th>
                <th scope="col" className="py-2 pr-4 font-medium">Duration</th>
                <th scope="col" className="py-2 pr-4 font-medium">Failures (24h)</th>
                <th scope="col" className="py-2 font-medium">Last error</th>
              </tr>
            </thead>
            <tbody>
              {sources.map((source) => (
                <tr key={source.sourceAdapterId} className="border-b border-neutral-200 dark:border-neutral-800">
                  <td className="py-1.5 pr-4 font-medium">{source.sourceAdapterId}</td>
                  <td className="py-1.5 pr-4 text-neutral-600 dark:text-neutral-300">{ago(source.lastSuccessAt, 'never')}</td>
                  <td className="py-1.5 pr-4 text-neutral-600 dark:text-neutral-300">
                    {ago(source.lastAttemptAt, 'never')}
                    {source.lastOutcome && (
                      <span className="ml-1 text-neutral-500 dark:text-neutral-400">({source.lastOutcome})</span>
                    )}
                  </td>
                  <td className="py-1.5 pr-4 tabular-nums text-neutral-600 dark:text-neutral-300">
                    {duration(source.lastDurationSeconds)}
                  </td>
                  <td className="py-1.5 pr-4 tabular-nums text-neutral-600 dark:text-neutral-300">
                    {source.failuresInWindow} of {source.attemptsInWindow}
                  </td>
                  <td className="py-1.5 text-neutral-500 dark:text-neutral-400">{source.lastError ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="mt-8">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-neutral-500 dark:text-neutral-400">This instance</h2>
        <dl className="mt-2 grid grid-cols-[12rem_1fr] gap-y-1 text-sm">
          <dt className="text-neutral-500 dark:text-neutral-400">Database size</dt>
          <dd className="tabular-nums">{size(databaseBytes)}</dd>
          <dt className="text-neutral-500 dark:text-neutral-400">Migrations applied</dt>
          {/*
            Quote this in a bug report and the first two questions are
            answered. The date is when the newest migration was written, not
            when it ran here — it names the schema, and "8d ago" on a database
            created this morning would name nothing.
          */}
          <dd className="tabular-nums">
            {migrations.applied}
            {migrations.newestAt && (
              <span className="ml-1 text-neutral-500 dark:text-neutral-400">
                newest dated {migrations.newestAt.toISOString().slice(0, 10)}
              </span>
            )}
          </dd>
          <dt className="text-neutral-500 dark:text-neutral-400">Sync interval</dt>
          <dd className="tabular-nums">{intervalSeconds}s</dd>
          <dt className="text-neutral-500 dark:text-neutral-400">Machine-readable</dt>
          <dd>
            <a className="underline" href="/api/health">/api/health</a>
            <span className="ml-1 text-neutral-500 dark:text-neutral-400">— the container healthcheck reads this</span>
          </dd>
        </dl>
      </section>

      <p className="mt-8 text-sm">
        <a className="underline" href="/">Back to the dashboard</a>
      </p>
    </main>
  );
}
