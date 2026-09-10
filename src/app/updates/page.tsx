import { existsSync } from 'node:fs';

import { redirect } from 'next/navigation';

import { loadConfig } from '../../config/load.ts';
import { collapseBy } from '../../core/group.ts';
import { dependencyLink, pullRequestUrl, repoUrl } from '../../core/links.ts';
import { openDatabase } from '../../db/client.ts';
import { forges, pendingUpdates, type ForgeInfo, type PendingUpdateRow } from '../../db/queries.ts';
import { foldUpdate } from '../collapse.ts';
import {
  filterByType,
  groupByDependency,
  isActive,
  readUpdateFilter,
  UPDATE_TYPES,
  type UpdateFilter,
} from './filter.ts';

export const dynamic = 'force-dynamic';

function read(): { updates: PendingUpdateRow[]; forge: Map<string, ForgeInfo>; compareUrl: string | null } {
  const config = loadConfig();
  if (config.sources.length === 0 || !existsSync(config.dbPath)) redirect('/preflight');

  const { sqlite, db } = openDatabase(config.dbPath);
  try {
    const forge = forges(db);
    // Collapse the copies a repository two sources both watch reports, so it
    // counts once under a dependency (Q-7, the same fold the dashboard uses).
    const updates = collapseBy(pendingUpdates(db), updateIdentity, (group) => foldUpdate(group, forge));
    return { updates, forge, compareUrl: config.compareUrl };
  } finally {
    sqlite.close();
  }
}

// The per-repository identity to fold copies on: the dependency and its version
// pair name the update; the source that reported it does not. A JSON tuple is
// the key so no field value can collide with a separator.
function updateIdentity(u: PendingUpdateRow): string {
  return JSON.stringify([u.repoFullName, u.dependencyName, u.currentVersion, u.targetVersion, u.updateType]);
}

function info(forge: Map<string, ForgeInfo>, row: { sourceAdapterId: string }): ForgeInfo {
  return forge.get(row.sourceAdapterId) ?? { platform: null, webBaseUrl: null };
}

/** A link, or the same text unlinked when nothing can be addressed. */
function Maybe({ href, children, title }: { href: string | null; children: React.ReactNode; title?: string }) {
  if (!href) return <>{children}</>;
  return (
    <a
      className="underline decoration-neutral-300 dark:decoration-neutral-700 hover:decoration-neutral-600"
      href={href}
      title={title}
      target="_blank"
      rel="noreferrer noopener"
    >
      {children}
    </a>
  );
}

/**
 * The type filter. A plain GET form, so the filter lands in the URL, survives a
 * reload, and works with scripting off — the same shape the repository list uses.
 */
function Filters({ filter, shownDeps, totalDeps }: { filter: UpdateFilter; shownDeps: number; totalDeps: number }) {
  return (
    <form method="get" action="/updates" className="mt-6 flex flex-wrap items-end gap-3">
      <div className="flex flex-col">
        <label className="text-xs uppercase tracking-wide text-neutral-500 dark:text-neutral-400" htmlFor="update-type">
          Update type
        </label>
        <select
          id="update-type"
          name="type"
          defaultValue={filter.type ?? ''}
          className="mt-1 rounded border border-neutral-300 dark:border-neutral-700 bg-transparent px-2 py-1 text-sm"
        >
          <option value="">any</option>
          {UPDATE_TYPES.map((type) => (
            <option key={type} value={type}>
              {type}
            </option>
          ))}
        </select>
      </div>
      <button type="submit" className="rounded border border-neutral-300 dark:border-neutral-700 px-3 py-1 text-sm">
        Filter
      </button>
      {isActive(filter) && (
        <span className="text-sm text-neutral-500 dark:text-neutral-400">
          <a className="underline" href="/updates">
            Clear
          </a>
          <span className="ml-3 tabular-nums">
            {shownDeps} of {totalDeps} shown
          </span>
        </span>
      )}
    </form>
  );
}

interface Props {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function Updates({ searchParams }: Props) {
  const params = await searchParams;
  const { updates, forge, compareUrl } = read();
  const filter = readUpdateFilter(params);
  const totalDeps = groupByDependency(updates).length;
  const groups = groupByDependency(filterByType(updates, filter));
  const repoTotal = new Set(updates.map((u) => u.repoFullName)).size;

  return (
    <main className="mx-auto max-w-4xl p-8">
      <h1 className="text-2xl font-semibold">Pending updates</h1>
      <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
        {totalDeps} {totalDeps === 1 ? 'dependency' : 'dependencies'} across {repoTotal}{' '}
        {repoTotal === 1 ? 'repository' : 'repositories'}, grouped by dependency so you can see every
        repository awaiting the same update.
      </p>

      {updates.length > 0 && <Filters filter={filter} shownDeps={groups.length} totalDeps={totalDeps} />}

      {updates.length === 0 ? (
        <p className="mt-6 text-sm text-neutral-500 dark:text-neutral-400">
          No named updates are pending. Lock-file refreshes are listed on the{' '}
          <a className="underline" href="/">dashboard</a>.
        </p>
      ) : groups.length === 0 ? (
        <p className="mt-6 text-sm text-neutral-500 dark:text-neutral-400">
          No update matches this filter. <a className="underline" href="/updates">Show all {totalDeps}</a>.
        </p>
      ) : (
        groups.map((group) => (
          <section key={`${group.dependencyName}/${group.datasource ?? ''}`} className="mt-8">
            <h2 className="text-sm font-semibold">
              {group.dependencyName}{' '}
              <span className="font-normal text-neutral-500 dark:text-neutral-400">
                ({group.rows.length} {group.rows.length === 1 ? 'repository' : 'repositories'})
              </span>
            </h2>
            <table className="mt-2 w-full text-sm">
              <tbody>
                {group.rows.map((row) => {
                  const link = dependencyLink(
                    row.datasource,
                    row.packageName,
                    row.currentVersion,
                    row.targetVersion,
                    compareUrl,
                  );
                  return (
                    <tr
                      key={`${row.repoFullName}/${row.targetVersion}`}
                      className="border-t border-neutral-200 dark:border-neutral-800"
                    >
                      <td className="py-1 pr-4 font-medium">
                        <Maybe href={repoUrl(info(forge, row).webBaseUrl, row.repoFullName)}>
                          {row.repoFullName}
                        </Maybe>
                      </td>
                      <td className="py-1 pr-4 tabular-nums text-neutral-600 dark:text-neutral-300">
                        <Maybe
                          href={link?.href ?? null}
                          title={
                            link?.kind === 'compare' ? 'Compare these two versions upstream' : 'Open the package page'
                          }
                        >
                          {row.currentVersion} → {row.targetVersion}
                        </Maybe>
                        {row.packageFileCount > 1 && (
                          <span className="ml-1 text-neutral-500 dark:text-neutral-400">×{row.packageFileCount} files</span>
                        )}
                      </td>
                      <td className="py-1 pr-4 text-neutral-500 dark:text-neutral-400">{row.updateType}</td>
                      <td className="py-1 text-neutral-500 dark:text-neutral-400">
                        {row.prNumber !== null && (
                          <Maybe
                            href={pullRequestUrl(
                              info(forge, row).webBaseUrl,
                              info(forge, row).platform,
                              row.repoFullName,
                              row.prNumber,
                            )}
                          >
                            PR #{row.prNumber}
                          </Maybe>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </section>
        ))
      )}

      <p className="mt-8 text-sm">
        <a className="underline" href="/">
          Back to the dashboard
        </a>
      </p>
    </main>
  );
}
