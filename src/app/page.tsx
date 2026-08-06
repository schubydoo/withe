import { existsSync } from 'node:fs';

import { redirect } from 'next/navigation';

import { loadConfig } from '../config/load.ts';
import { isHeld } from '../core/renovate-log.ts';
import { openDatabase } from '../db/client.ts';
import {
  lastSync,
  lockFileRefreshes,
  pendingUpdates,
  repoHealth,
  type PendingUpdateRow,
} from '../db/queries.ts';

export const dynamic = 'force-dynamic';

function read() {
  // An unconfigured or never-synced instance is sent to the setup check rather
  // than shown an empty dashboard. An unexplained empty page is the failure
  // that loses a first-time user, and it looks identical to a broken install.
  const config = loadConfig();
  if (config.sources.length === 0) redirect('/preflight');
  if (!existsSync(config.dbPath)) redirect('/preflight');

  // Reads only. No source is called while a page renders, so an unreachable
  // server makes this stale rather than broken.
  const { sqlite, db } = openDatabase(config.dbPath);
  try {
    return {
      updates: pendingUpdates(db),
      locks: lockFileRefreshes(db),
      repos: repoHealth(db),
      sync: lastSync(db),
    };
  } finally {
    sqlite.close();
  }
}

function Group({ title, rows, empty }: { title: string; rows: PendingUpdateRow[]; empty: string }) {
  return (
    <section className="mt-8">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-neutral-500">
        {title} <span className="font-normal">({rows.length})</span>
      </h2>
      {rows.length === 0 ? (
        <p className="mt-2 text-sm text-neutral-500">{empty}</p>
      ) : (
        <table className="mt-2 w-full text-sm">
          <tbody>
            {rows.map((row) => (
              <tr key={`${row.repoFullName}/${row.dependencyName}/${row.targetVersion}`} className="border-t border-neutral-200">
                <td className="py-1 pr-4 text-neutral-500">{row.repoFullName}</td>
                <td className="py-1 pr-4 font-medium">
                  {row.dependencyName}
                  {row.packageFileCount > 1 && (
                    <span className="ml-1 text-neutral-400">×{row.packageFileCount} files</span>
                  )}
                </td>
                <td className="py-1 pr-4 tabular-nums text-neutral-600">
                  {row.currentVersion} → {row.targetVersion}
                </td>
                <td className="py-1 pr-4 text-neutral-500">{row.updateType}</td>
                <td className="py-1 text-neutral-500">
                  {row.prNumber === null ? '' : `PR #${row.prNumber}`}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

export default function Home() {
  const { updates, locks, repos, sync } = read();

  if (repos.length === 0) redirect('/preflight');

  const held = updates.filter((u) => isHeld({ updateType: u.updateType, currentVersion: u.currentVersion }));
  const heldKeys = new Set(held);
  const rest = updates.filter((u) => !heldKeys.has(u));
  const open = rest.filter((u) => u.prNumber !== null);
  const queued = rest.filter((u) => u.prNumber === null);

  const failing = repos.filter((r) => r.status !== null && r.status !== 'success');
  const idle = repos.filter((r) => r.pendingCount === 0);

  return (
    <main className="mx-auto max-w-4xl p-8">
      <h1 className="text-2xl font-semibold">Withe</h1>
      <p className="mt-1 text-sm text-neutral-500">
        {repos.length} repositories · {updates.length + locks.total} pending updates ·{' '}
        {sync.lastSyncAt ? `synced ${sync.lastSyncAt.toISOString()}` : 'never synced'}
      </p>

      <p className="mt-4 rounded border border-neutral-200 bg-neutral-50 px-3 py-2 text-sm">
        {failing.length === 0
          ? 'No failures. Every repository’s most recent run succeeded.'
          : `Failing: ${failing.map((r) => `${r.fullName} (${r.status})`).join(', ')}`}
      </p>

      <Group
        title="Held for your review"
        rows={held}
        empty="Nothing is waiting on a decision. Majors and 0.x minors appear here."
      />
      <Group title="Open pull requests" rows={open} empty="No update has an open pull request." />
      <Group title="Queued, no pull request yet" rows={queued} empty="Nothing is queued." />

      <section className="mt-8 text-sm text-neutral-500">
        <p>
          {locks.total === 0
            ? 'No lock-file refreshes pending.'
            : `${locks.total} lock-file refreshes pending across ${locks.repos} repositories, not listed individually.`}
        </p>
        {idle.length > 0 && (
          <p className="mt-1">Up to date: {idle.map((r) => r.fullName).join(', ')}</p>
        )}
      </section>
    </main>
  );
}
