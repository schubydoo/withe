/**
 * What Withe knows about itself (Task 3.6).
 *
 * Written for the two moments it is read: a dashboard that looks stale, and a
 * bug report that needs the version of the schema it was filed against.
 */
import { existsSync, statSync } from 'node:fs';

import { loadConfig } from '../../config/load.ts';
import { assess, STALE_AFTER_INTERVALS } from '../../core/health.ts';
import { openDatabase } from '../../db/client.ts';
import { migrationState, sourceHealth, sourceSystems, type MigrationState, type SourceHealth, type SourceSystem } from '../../db/queries.ts';
import { ago } from '../format.ts';
import { describeAge } from '../staleness.ts';

export const dynamic = 'force-dynamic';

const DAY_MS = 24 * 60 * 60 * 1000;

interface Report {
  sources: SourceHealth[];
  systems: SourceSystem[];
  migrations: MigrationState;
  databaseBytes: number | null;
  intervalSeconds: number;
}

function read(): Report {
  const config = loadConfig();
  if (!existsSync(config.dbPath)) {
    return { sources: [], systems: [], migrations: { applied: 0, newestAt: null }, databaseBytes: null, intervalSeconds: config.syncIntervalSeconds };
  }

  const { sqlite, db } = openDatabase(config.dbPath);
  try {
    return {
      sources: sourceHealth(db, new Date(Date.now() - DAY_MS)),
      systems: sourceSystems(db),
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

/** Whether the source reported anything at all from its system API. */
function hasSystemFacts(system: SourceSystem): boolean {
  return (
    system.queueDepth !== null ||
    system.runnerVersion !== null ||
    system.bootedAt !== null ||
    system.oldestQueuedAt !== null
  );
}

function duration(seconds: number | null): string {
  if (seconds === null) return '—';
  return seconds < 1 ? 'under a second' : `${seconds}s`;
}

export default function HealthPage() {
  const { sources, systems, migrations, databaseBytes, intervalSeconds } = read();
  const health = assess(sources, intervalSeconds);
  // Sources with at least one successful sync: only those can be said to have
  // "reported nothing" — the rest simply have not reported at all.
  const everSynced = new Set(sources.filter((s) => s.lastSuccessAt !== null).map((s) => s.sourceAdapterId));

  // NFR-18: the state is a word first. The colour repeats it, never replaces it.
  const tone =
    health.status === 'ok'
      ? 'bg-green-100 dark:bg-green-900 text-green-800 dark:text-green-300'
      : health.status === 'stale'
        ? 'bg-red-100 dark:bg-red-900 text-red-800 dark:text-red-300'
        : 'bg-amber-100 dark:bg-amber-900 text-amber-900 dark:text-amber-200';
  // The badge carries the state word (NFR-18); the summary adds the specifics.
  const label = health.status === 'ok' ? 'Up to date' : health.status === 'stale' ? 'Behind' : 'Not started';
  const behindMinutes = Math.round((intervalSeconds * STALE_AFTER_INTERVALS) / 60);
  const summary =
    health.status === 'ok'
      ? // ageSeconds is the freshest source's age, so name it as that — on a
        // multi-source install one can lag while another is current.
        `The freshest data from Renovate is ${describeAge(health.ageSeconds ?? 0)}.`
      : health.status === 'stale'
        ? // Name only the sources that are behind; assess() turns stale when any
          // one is, while the rest may have synced seconds ago.
          `Not reached in over ${behindMinutes} minutes: ${health.stale.join(', ')}. The data below may be out of date.`
        : "Withe hasn't pulled from Renovate yet — the preflight page says why.";

  return (
    <main className="mx-auto max-w-5xl p-8">
      <h1 className="text-2xl font-semibold">Renovate health</h1>
      <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
        Whether Withe is reaching your Renovate server and staying current — not the
        state of the repositories Renovate scans.
      </p>
      <p className="mt-3">
        <span className={`rounded px-1.5 py-0.5 text-sm ${tone}`}>{label}</span>
        <span className="ml-2 text-sm text-neutral-600 dark:text-neutral-300">{summary}</span>
      </p>

      <section className="mt-8">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-neutral-500 dark:text-neutral-400">Renovate sources</h2>
        <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
          The Renovate server(s) Withe pulls from. A failure here is Withe not reaching that
          server — not an error Renovate hit while scanning your repositories.
        </p>
        {sources.length === 0 ? (
          <p className="mt-2 text-sm text-neutral-500 dark:text-neutral-400">
            No source has been recorded yet. <a className="underline" href="/preflight">Check the setup</a>.
          </p>
        ) : (
          <table className="mt-2 w-full text-sm">
            <caption className="sr-only">Each Renovate server Withe pulls from, with its most recent sync.</caption>
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

      {/* Only when a source actually has a server: the heading names one, so a
          log-directory-only instance must not raise it. In a mixed install the
          server rows show their facts and a log-directory row explains its blank. */}
      {systems.some((system) => system.reportsSystemFacts) && (
        <section className="mt-8">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-neutral-500 dark:text-neutral-400">Renovate server</h2>
          <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
            What the server reports about itself: its job queue, version and boot time.
            Values refresh with each sync.
          </p>
          {systems.map((system) => (
            <div key={system.sourceAdapterId} className="mt-2">
              {systems.length > 1 && <h3 className="text-sm font-medium">{system.sourceAdapterId}</h3>}
              {!everSynced.has(system.sourceAdapterId) ? (
                // All-null facts on a source that has never synced mean nothing
                // about the system API; blaming a setting here would send the
                // operator to fix the wrong thing.
                <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
                  No sync has completed yet, so nothing has been reported. The table above says how
                  the syncs are going.
                </p>
              ) : hasSystemFacts(system) ? (
                <dl className="mt-1 grid grid-cols-[12rem_1fr] gap-y-1 text-sm">
                  <dt className="text-neutral-500 dark:text-neutral-400">Queue depth</dt>
                  <dd className="tabular-nums">
                    {system.queueDepth === null ? '—' : system.queueDepth === 0 ? '0 — nothing waiting' : system.queueDepth}
                  </dd>
                  <dt className="text-neutral-500 dark:text-neutral-400">Oldest waiting job</dt>
                  <dd>
                    {system.oldestQueuedAt === null
                      ? '—'
                      : `${system.oldestQueuedRepo ?? 'unknown repository'}, queued ${ago(system.oldestQueuedAt, '—')}`}
                  </dd>
                  <dt className="text-neutral-500 dark:text-neutral-400">Renovate version</dt>
                  <dd className="tabular-nums">{system.runnerVersion ?? '—'}</dd>
                  <dt className="text-neutral-500 dark:text-neutral-400">Booted</dt>
                  <dd>{ago(system.bootedAt, '—')}</dd>
                </dl>
              ) : !system.reportsSystemFacts ? (
                // Some sources have no server to query — a log directory is
                // files, not a runner — so an empty panel is expected, not a
                // setting left off. The capability comes from the data (Task
                // 4.3); the page does not name the kind, which the architecture
                // forbids (check-boundaries: no-adapter-branching-in-web).
                <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
                  This source has no server to query — Withe reads it directly, so it reports no
                  queue, version or boot time, and there is nothing to enable.
                </p>
              ) : (
                // A server-backed source with no fact at all means the system
                // API is off. Naming the check beats an empty panel.
                <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
                  This server reports nothing about itself — its system status API is likely not
                  enabled. The <a className="underline" href="/preflight">setup check</a> names the
                  setting.
                </p>
              )}
            </div>
          ))}
        </section>
      )}

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
