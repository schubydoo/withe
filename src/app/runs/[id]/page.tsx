import { existsSync } from 'node:fs';

import { notFound, redirect } from 'next/navigation';

import { loadConfig } from '../../../config/load.ts';
import { openDatabase } from '../../../db/client.ts';
import { runLocation, runsForRepo } from '../../../db/queries.ts';
import { LogViewer } from './log-viewer.tsx';

export const dynamic = 'force-dynamic';

export default async function RunDetail({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ q?: string | string[] }>;
}) {
  const { id: raw } = await params;
  // `?q=` prefills the log search. The dashboard uses it to point at the branch
  // whose manifests the operator asked to see.
  const { q } = await searchParams;
  const search = Array.isArray(q) ? (q[0] ?? '') : (q ?? '');
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
        {(run.completedAt ?? run.startedAt ?? run.queuedAt)?.toISOString().replace('T', ' ').slice(0, 19) ??
          'not started'}
        {run.runnerVersion && ` · Renovate ${run.runnerVersion}`}
      </p>

      {run.error && (
        <p className="mt-3 rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
          {run.error}
        </p>
      )}

      {run.logAvailable ? (
        <LogViewer runId={id} initialSearch={search} />
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
