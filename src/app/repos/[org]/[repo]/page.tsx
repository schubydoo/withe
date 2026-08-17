import { existsSync } from 'node:fs';

import { notFound, redirect } from 'next/navigation';

import { loadConfig } from '../../../../config/load.ts';
import { openDatabase } from '../../../../db/client.ts';
import { repoInventory, runsForRepo, RUNS_PER_PAGE, type RunRow } from '../../../../db/queries.ts';
import { runWhen } from '../../../format.ts';

export const dynamic = 'force-dynamic';

interface Props {
  params: Promise<{ org: string; repo: string }>;
  searchParams: Promise<{ page?: string }>;
}

function read(fullName: string, page: number) {
  const config = loadConfig();
  if (config.sources.length === 0 || !existsSync(config.dbPath)) redirect('/preflight');

  const { sqlite, db } = openDatabase(config.dbPath);
  try {
    const known = repoInventory(db).find((r) => r.fullName === fullName);
    return { known, ...runsForRepo(db, fullName, page) };
  } finally {
    sqlite.close();
  }
}

/** How long a finished run took, or how long a waiting one has waited. */
function timing(run: RunRow): { label: string; value: string } {
  if (run.startedAt && run.completedAt) {
    const seconds = Math.max(0, Math.round((run.completedAt.getTime() - run.startedAt.getTime()) / 1000));
    return { label: 'took', value: seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s` };
  }
  if (run.startedAt) return { label: 'running for', value: since(run.startedAt) };
  // A queued run has no duration to report, so it reports its wait instead.
  // Showing a dash there hides the number that matters when a queue is stuck.
  if (run.queuedAt) return { label: 'waiting', value: since(run.queuedAt) };
  return { label: '', value: '—' };
}

function since(when: Date): string {
  const seconds = Math.max(0, Math.round((Date.now() - when.getTime()) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  return minutes < 120 ? `${minutes}m` : `${Math.round(minutes / 60)}h`;
}

const TONE: Record<string, string> = {
  success: 'bg-green-100 dark:bg-green-900 text-green-800 dark:text-green-300',
  failed: 'bg-red-100 dark:bg-red-900 text-red-800 dark:text-red-300',
  queued: 'bg-neutral-100 dark:bg-neutral-800 text-neutral-700 dark:text-neutral-300',
  running: 'bg-blue-100 dark:bg-blue-900 text-blue-800 dark:text-blue-300',
  unknown: 'bg-neutral-100 dark:bg-neutral-800 text-neutral-600 dark:text-neutral-300',
};

export default async function RunHistory({ params, searchParams }: Props) {
  const { org, repo } = await params;
  const { page: rawPage } = await searchParams;
  const fullName = `${decodeURIComponent(org)}/${decodeURIComponent(repo)}`;
  const page = Math.max(0, Number(rawPage ?? '0') || 0);

  const { known, runs, total } = read(fullName, page);
  if (!known) notFound();

  const pages = Math.max(1, Math.ceil(total / RUNS_PER_PAGE));
  const failures = runs.filter((r) => r.status === 'failed').length;

  return (
    <main className="mx-auto max-w-4xl p-8">
      <h1 className="text-2xl font-semibold">{fullName}</h1>
      <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
        {total} {total === 1 ? 'run' : 'runs'}
        {known.removedAt && ' · removed at the source, history kept'}
        {failures > 0 && ` · ${failures} failed on this page`}
        {runs[0]?.runnerVersion && ` · Renovate ${runs[0].runnerVersion}`}
      </p>

      <table className="mt-6 w-full text-sm">
        <caption className="sr-only">Runs for {fullName}, newest first.</caption>
        <thead>
          <tr className="border-b border-neutral-300 dark:border-neutral-700 text-left text-xs uppercase tracking-wide text-neutral-500 dark:text-neutral-400">
            <th scope="col" className="py-2 pr-4 font-medium">When</th>
            <th scope="col" className="py-2 pr-4 font-medium">Status</th>
            <th scope="col" className="py-2 pr-4 font-medium">Duration</th>
            <th scope="col" className="py-2 font-medium">Reason</th>
          </tr>
        </thead>
        <tbody>
          {runs.map((run) => {
            const { label, value } = timing(run);
            return (
              <tr key={run.externalJobId} className="border-b border-neutral-200 dark:border-neutral-800 align-top">
                <td className="py-1.5 pr-4 whitespace-nowrap text-neutral-600 dark:text-neutral-300">
                  {runWhen(run) ?? '—'}
                </td>
                <td className="py-1.5 pr-4">
                  <span className={`rounded px-1.5 py-0.5 text-xs ${TONE[run.status] ?? TONE.unknown}`}>
                    {run.status}
                  </span>
                  {run.error && (
                    <p className="mt-1 max-w-md text-xs text-red-800 dark:text-red-300">
                      <span className="font-medium">Run error:</span> {run.error}
                    </p>
                  )}
                  {run.artifactErrors.length > 0 && (
                    <div className="mt-1 max-w-md text-xs text-amber-900 dark:text-amber-200">
                      {/* Kept apart from the run error on purpose: a run can
                          succeed and still fail to update a lock file. */}
                      <span className="font-medium">
                        Artifact {run.artifactErrors.length === 1 ? 'error' : 'errors'}:
                      </span>
                      <ul className="ml-4 list-disc">
                        {run.artifactErrors.map((line) => (
                          <li key={line}>{line}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                </td>
                <td className="py-1.5 pr-4 whitespace-nowrap text-neutral-600 dark:text-neutral-300">
                  {label && <span className="text-neutral-500 dark:text-neutral-400">{label} </span>}
                  {value}
                </td>
                <td className="py-1.5 text-neutral-600 dark:text-neutral-300">
                  {run.reason ?? '—'}
                  {run.logAvailable ? (
                    <a className="ml-3 text-xs underline" href={`/runs/${run.id}`}>
                      log
                    </a>
                  ) : (
                    // F-06: a purged log is marked, not offered. Letting the
                    // operator click into a 404 is the failure this prevents.
                    <span className="ml-3 text-xs text-neutral-500 dark:text-neutral-400" title="No longer retained by the Renovate server">
                      log gone
                    </span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      {runs.length === 0 && total === 0 && (
        <p className="mt-4 text-sm text-neutral-500 dark:text-neutral-400">No runs recorded yet.</p>
      )}
      {runs.length === 0 && total > 0 && (
        // Saying "no runs recorded" here would be false: there are runs, this
        // page is simply past the end of them.
        <p className="mt-4 text-sm text-neutral-500 dark:text-neutral-400">
          Page {page + 1} is past the end of {total} runs.{' '}
          <a className="underline" href="?page=0">
            Back to the newest
          </a>
          .
        </p>
      )}

      {pages > 1 && (
        <nav className="mt-6 flex items-center gap-4 text-sm" aria-label="Run history pages">
          {page > 0 && (
            <a className="underline" href={`?page=${page - 1}`}>
              Newer
            </a>
          )}
          <span className="text-neutral-500 dark:text-neutral-400">
            Page {page + 1} of {pages}
          </span>
          {page + 1 < pages && (
            <a className="underline" href={`?page=${page + 1}`}>
              Older
            </a>
          )}
        </nav>
      )}

      <p className="mt-8 text-sm">
        <a className="underline" href="/repos">
          All repositories
        </a>
      </p>
    </main>
  );
}
