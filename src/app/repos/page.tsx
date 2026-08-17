import { existsSync } from 'node:fs';

import { redirect } from 'next/navigation';

import { loadConfig } from '../../config/load.ts';
import { repoUrl } from '../../core/links.ts';
import { openDatabase } from '../../db/client.ts';
import { forges, repoInventory, type ForgeInfo, type InventoryRow } from '../../db/queries.ts';
import { ago } from '../format.ts';

export const dynamic = 'force-dynamic';

function read(): { rows: InventoryRow[]; forge: Map<string, ForgeInfo> } {
  const config = loadConfig();
  if (config.sources.length === 0 || !existsSync(config.dbPath)) redirect('/preflight');

  const { sqlite, db } = openDatabase(config.dbPath);
  try {
    return { rows: repoInventory(db), forge: forges(db) };
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
  if (row.removedAt) return { label: 'removed', tone: 'bg-neutral-200 dark:bg-neutral-800 text-neutral-700 dark:text-neutral-300' };
  if (!row.enabled) return { label: 'disabled', tone: 'bg-neutral-100 dark:bg-neutral-800 text-neutral-600 dark:text-neutral-300' };
  if (row.lastRunStatus === 'failed') return { label: 'failing', tone: 'bg-red-100 dark:bg-red-900 text-red-800 dark:text-red-300' };
  if (row.stalled) return { label: 'stalled', tone: 'bg-amber-100 dark:bg-amber-900 text-amber-900 dark:text-amber-200' };
  if (row.lastRunStatus === null) return { label: 'no runs yet', tone: 'bg-neutral-100 dark:bg-neutral-800 text-neutral-600 dark:text-neutral-300' };
  return { label: 'active', tone: 'bg-green-100 dark:bg-green-900 text-green-800 dark:text-green-300' };
}

export default function Repos() {
  const { rows, forge } = read();
  const orgs = [...new Set(rows.map((r) => r.org))];
  const removed = rows.filter((r) => r.removedAt).length;

  return (
    <main className="mx-auto max-w-5xl p-8">
      <h1 className="text-2xl font-semibold">Repositories</h1>
      <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
        {rows.length} across {orgs.length} {orgs.length === 1 ? 'organization' : 'organizations'}
        {removed > 0 && `, ${removed} removed at the source and kept for their history`}
      </p>

      <table className="mt-6 w-full text-sm">
        <caption className="sr-only">
          Every repository Withe knows about, with its state and most recent run.
        </caption>
        <thead>
          <tr className="border-b border-neutral-300 dark:border-neutral-700 text-left text-xs uppercase tracking-wide text-neutral-500 dark:text-neutral-400">
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
              <tr key={`${row.sourceAdapterId}/${row.fullName}`} className="border-b border-neutral-200 dark:border-neutral-800">
                <td className="py-1.5 pr-4">
                  <a
                    className="underline decoration-neutral-300 dark:decoration-neutral-700 hover:decoration-neutral-600"
                    href={`/repos/${encodeURIComponent(row.org)}/${encodeURIComponent(row.name)}`}
                  >
                    <span className="text-neutral-500 dark:text-neutral-400">{row.org}/</span>
                    <span className="font-medium">{row.name}</span>
                  </a>
                  {(() => {
                    // The name goes to Withe's own history; this goes to the
                    // forge. Two destinations, so two targets rather than one
                    // link the operator has to guess about.
                    const href = repoUrl(
                      forge.get(row.sourceAdapterId)?.webBaseUrl ?? null,
                      row.fullName,
                    );
                    return href ? (
                      <a
                        className="ml-2 text-xs text-neutral-500 dark:text-neutral-400 underline"
                        href={href}
                        target="_blank"
                        rel="noreferrer noopener"
                        title="Open on the forge"
                      >
                        forge
                      </a>
                    ) : null;
                  })()}
                </td>
                <td className="py-1.5 pr-4">
                  <span className={`rounded px-1.5 py-0.5 text-xs ${tone}`}>{label}</span>
                </td>
                <td className="py-1.5 pr-4 text-neutral-600 dark:text-neutral-300">{row.installStatus ?? '—'}</td>
                <td className="py-1.5 pr-4 text-neutral-600 dark:text-neutral-300">{row.queueName ?? '—'}</td>
                <td className="py-1.5 pr-4 text-neutral-600 dark:text-neutral-300">
                  {ago(row.lastRunAt, '—')}
                  {row.lastRunStatus && row.lastRunStatus !== 'success' && (
                    <span className="ml-1 text-neutral-500 dark:text-neutral-400">({row.lastRunStatus})</span>
                  )}
                </td>
                <td className="py-1.5 tabular-nums text-neutral-600 dark:text-neutral-300">
                  {row.pendingCount === 0 ? '—' : row.pendingCount}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      {rows.length === 0 && (
        <p className="mt-4 text-sm text-neutral-500 dark:text-neutral-400">
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
