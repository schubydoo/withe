import { existsSync } from 'node:fs';

import { notFound, redirect } from 'next/navigation';

import { loadConfig } from '../../../config/load.ts';
import { openDatabase } from '../../../db/client.ts';
import { runLocation, runsForRepo } from '../../../db/queries.ts';
import { runWhen } from '../../format.ts';
import { LogViewer } from './log-viewer.tsx';

export const dynamic = 'force-dynamic';

export default async function RunDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id: raw } = await params;
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) notFound();

  const config = loadConfig();
  if (config.sources.length === 0 || !existsSync(config.dbPath)) redirect('/preflight');

  const { sqlite, db } = openDatabase(config.dbPath);
  let location;
  let run;
  try {
    location = runLocation(db, id);
    if (location) {
      run = runsForRepo(db, location.repoFullName, 0, 1000).runs.find((r) => r.id === id);
    }
  } finally {
    sqlite.close();
  }
  if (!location || !run) notFound();

  const [org, name] = location.repoFullName.split('/');

  return (
    <main className="mx-auto max-w-6xl p-8">
      <h1 className="text-2xl font-semibold">{location.repoFullName}</h1>
      <p className="mt-1 text-sm text-neutral-500">
        {run.status} · {run.reason ?? 'no reason recorded'} ·{' '}
        {runWhen(run) ?? 'not started'}
        {run.runnerVersion && ` · Renovate ${run.runnerVersion}`}
      </p>

      {run.error && (
        <p className="mt-3 rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
          {run.error}
        </p>
      )}

      {run.logAvailable && (
        <p className="mt-4 text-sm">
          <a className="underline" href={`/api/runs/${id}/log?download=1`}>
            Download log
          </a>{' '}
          <span className="text-neutral-500">— the whole log, as Renovate served it.</span>
        </p>
      )}

      {run.logAvailable ? (
        <LogViewer runId={id} />
      ) : (
        <p className="mt-4 rounded border border-neutral-200 bg-neutral-50 px-3 py-2 text-sm text-neutral-600">
          The Renovate server no longer holds this run&rsquo;s log. Withe keeps run history
          indefinitely; logs are fetched on demand and are never stored.
        </p>
      )}

      <p className="mt-8 text-sm">
        <a className="underline" href={`/repos/${encodeURIComponent(org ?? '')}/${encodeURIComponent(name ?? '')}`}>
          Back to {location.repoFullName}
        </a>
      </p>
    </main>
  );
}
