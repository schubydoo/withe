import { existsSync } from 'node:fs';

import { redirect } from 'next/navigation';

import { loadConfig } from '../../config/load.ts';
import { repoUrl } from '../../core/links.ts';
import { openDatabase } from '../../db/client.ts';
import { forges, repoInventory, type ForgeInfo, type InventoryRow } from '../../db/queries.ts';
import { ago } from '../format.ts';
import { distinctSources, groupByFullName } from './group.ts';

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

interface Props {
  // Typed wide: other filters (the search box's q and state) share this query
  // string, and the source links below must carry them rather than drop them.
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

/** This page's URL with the source filter changed and every other filter kept. */
function sourceHref(params: Record<string, string | string[] | undefined>, source: string | null): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (key === 'source' || value === undefined) continue;
    for (const one of Array.isArray(value) ? value : [value]) query.append(key, one);
  }
  if (source !== null) query.set('source', source);
  const text = query.toString();
  return text === '' ? '/repos' : `/repos?${text}`;
}

export default async function Repos({ searchParams }: Props) {
  const params = await searchParams;
  const rawSource = Array.isArray(params.source) ? params.source.at(-1) : params.source;
  const { rows, forge } = read();
  // Which sources exist comes from the data, not the filter, so the filter
  // links stay visible while one is active. An unknown value shows everything
  // rather than an error page — same rule as an unknown state elsewhere.
  const sources = distinctSources(rows);
  const source = typeof rawSource === 'string' && sources.includes(rawSource) ? rawSource : null;
  const grouped = groupByFullName(source ? rows.filter((r) => r.sourceAdapterId === source) : rows);
  const shown = grouped.map((g) => g.primary);
  const orgs = [...new Set(shown.map((r) => r.org))];
  const removed = shown.filter((r) => r.removedAt).length;

  return (
    <main className="mx-auto max-w-5xl p-8">
      <h1 className="text-2xl font-semibold">Repositories</h1>
      <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
        {shown.length} across {orgs.length} {orgs.length === 1 ? 'organization' : 'organizations'}
        {removed > 0 && `, ${removed} removed at the source and kept for their history`}
      </p>

      {sources.length > 1 && (
        // Only a multi-source install is offered the filter: with one source
        // the labels would name the same thing on every row (Task 4.4).
        <p className="mt-2 text-sm text-neutral-600 dark:text-neutral-300">
          Source:{' '}
          {source === null ? (
            <span className="font-medium">all</span>
          ) : (
            <a className="underline" href={sourceHref(params, null)}>all</a>
          )}
          {sources.map((id) => (
            <span key={id} className="ml-2">
              {source === id ? (
                <span className="font-medium">{id}</span>
              ) : (
                <a className="underline" href={sourceHref(params, id)}>{id}</a>
              )}
            </span>
          ))}
        </p>
      )}

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
          {grouped.map(({ primary: row, rows: group, sources: contributors }) => {
            const { label, tone } = state(row);
            // One contributor can know what another does not: take the fuller
            // pending count, and the first forge link any contributor carries.
            const pendingCount = Math.max(...group.map((r) => r.pendingCount));
            const forgeHref = group
              .map((r) => repoUrl(forge.get(r.sourceAdapterId)?.webBaseUrl ?? null, r.fullName))
              .find((href) => href !== null) ?? null;
            return (
              <tr key={row.fullName} className="border-b border-neutral-200 dark:border-neutral-800">
                <td className="py-1.5 pr-4">
                  <a
                    className="underline decoration-neutral-300 dark:decoration-neutral-700 hover:decoration-neutral-600"
                    href={`/repos/${encodeURIComponent(row.org)}/${encodeURIComponent(row.name)}`}
                  >
                    <span className="text-neutral-500 dark:text-neutral-400">{row.org}/</span>
                    <span className="font-medium">{row.name}</span>
                  </a>
                  {/* The name goes to Withe's own history; this goes to the
                      forge. Two destinations, so two targets rather than one
                      link the operator has to guess about. */}
                  {forgeHref && (
                    <a
                      className="ml-2 text-xs text-neutral-500 dark:text-neutral-400 underline"
                      href={forgeHref}
                      target="_blank"
                      rel="noreferrer noopener"
                      title="Open on the forge"
                    >
                      forge
                    </a>
                  )}
                  {sources.length > 1 && (
                    <span className="ml-2 text-xs text-neutral-500 dark:text-neutral-400">
                      {contributors.join(' + ')}
                    </span>
                  )}
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
                  {pendingCount === 0 ? '—' : pendingCount}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      {shown.length === 0 && (
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
