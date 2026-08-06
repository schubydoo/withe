import { existsSync } from 'node:fs';

import { redirect } from 'next/navigation';

import { loadConfig } from '../../config/load.ts';
import { openDatabase } from '../../db/client.ts';
import { repoInventory, type InventoryRow } from '../../db/queries.ts';

export const dynamic = 'force-dynamic';

function read(): InventoryRow[] {
  const config = loadConfig();
  if (config.sources.length === 0 || !existsSync(config.dbPath)) redirect('/preflight');

  const { sqlite, db } = openDatabase(config.dbPath);
  try {
    return repoInventory(db);
  } finally {
    sqlite.close();
  }
}

/**
 * The state of one repository, as words.
 *
 * NFR-18 forbids conveying status by colour alone, so every state carries a
 * label. The colour is a second signal, never the only one.
 */
function state(row: InventoryRow): { label: string; tone: string } {
  if (row.removedAt) return { label: 'removed', tone: 'bg-neutral-200 text-neutral-700' };
  if (!row.enabled) return { label: 'disabled', tone: 'bg-neutral-100 text-neutral-600' };
  if (row.lastRunStatus === 'failed') return { label: 'failing', tone: 'bg-red-100 text-red-800' };
  if (row.stalled) return { label: 'stalled', tone: 'bg-amber-100 text-amber-900' };
  if (row.lastRunStatus === null) return { label: 'no runs yet', tone: 'bg-neutral-100 text-neutral-600' };
  return { label: 'active', tone: 'bg-green-100 text-green-800' };
}

function ago(when: Date | null): string {
  if (!when) return '—';
  const minutes = Math.round((Date.now() - when.getTime()) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

export default function Repos() {
  const rows = read();
  const orgs = [...new Set(rows.map((r) => r.org))];
  const removed = rows.filter((r) => r.removedAt).length;

  return (
    <main className="mx-auto max-w-5xl p-8">
      <h1 className="text-2xl font-semibold">Repositories</h1>
      <p className="mt-1 text-sm text-neutral-500">
        {rows.length} across {orgs.length} {orgs.length === 1 ? 'organization' : 'organizations'}
        {removed > 0 && `, ${removed} removed at the source and kept for their history`}
      </p>

      <table className="mt-6 w-full text-sm">
        <caption className="sr-only">
          Every repository Withe knows about, with its state and most recent run.
        </caption>
        <thead>
          <tr className="border-b border-neutral-300 text-left text-xs uppercase tracking-wide text-neutral-500">
            <th scope="col" className="py-2 pr-4 font-medium">Repository</th>
            <th scope="col" className="py-2 pr-4 font-medium">State</th>
            <th scope="col" className="py-2 pr-4 font-medium">Install</th>
            <th scope="col" className="py-2 pr-4 font-medium">Queue</th>
            <th scope="col" className="py-2 pr-4 font-medium">Last run</th>
            <th scope="col" className="py-2 font-medium">Pending</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const { label, tone } = state(row);
            return (
              <tr key={`${row.sourceAdapterId}/${row.fullName}`} className="border-b border-neutral-200">
                <td className="py-1.5 pr-4">
                  <span className="text-neutral-500">{row.org}/</span>
                  <span className="font-medium">{row.name}</span>
                </td>
                <td className="py-1.5 pr-4">
                  <span className={`rounded px-1.5 py-0.5 text-xs ${tone}`}>{label}</span>
                </td>
                <td className="py-1.5 pr-4 text-neutral-600">{row.installStatus ?? '—'}</td>
                <td className="py-1.5 pr-4 text-neutral-600">{row.queueName ?? '—'}</td>
                <td className="py-1.5 pr-4 text-neutral-600">
                  {ago(row.lastRunAt)}
                  {row.lastRunStatus && row.lastRunStatus !== 'success' && (
                    <span className="ml-1 text-neutral-500">({row.lastRunStatus})</span>
                  )}
                </td>
                <td className="py-1.5 tabular-nums text-neutral-600">
                  {row.pendingCount === 0 ? '—' : row.pendingCount}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      {rows.length === 0 && (
        <p className="mt-4 text-sm text-neutral-500">
          No repositories yet. The <a className="underline" href="/preflight">setup check</a> says
          why.
        </p>
      )}

      <p className="mt-8 text-sm">
        <a className="underline" href="/">
          Back to the dashboard
        </a>
      </p>
    </main>
  );
}
