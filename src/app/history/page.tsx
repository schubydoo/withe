import { existsSync } from 'node:fs';

import { redirect } from 'next/navigation';

import { loadConfig } from '../../config/load.ts';
import { pullRequestUrl, repoUrl } from '../../core/links.ts';
import { openDatabase } from '../../db/client.ts';
import {
  completedUpdates,
  forges,
  repoInventory,
  type CompletedUpdateRow,
  type ForgeInfo,
} from '../../db/queries.ts';
import { ago } from '../format.ts';
import { groupByDependency } from '../updates/filter.ts';
import { byLatestLanding, byNewest, readRepoFilter, tally } from './filter.ts';

export const dynamic = 'force-dynamic';

/** How many records the page renders. The archive outgrows a page long before it outgrows the disk. */
const LIMIT = 250;

interface PageData {
  rows: CompletedUpdateRow[];
  forge: Map<string, ForgeInfo>;
  /** Every repository with a record, for the filter control. */
  repoNames: string[];
  /** False when no GitHub token is set, which is why the history can be empty. */
  forgeConfigured: boolean;
}

function read(repoFilter: string | null): PageData {
  const config = loadConfig();
  if (config.sources.length === 0 || !existsSync(config.dbPath)) redirect('/preflight');

  const { sqlite, db } = openDatabase(config.dbPath);
  try {
    return {
      rows: completedUpdates(db, LIMIT, repoFilter ?? undefined),
      forge: forges(db),
      repoNames: repoInventory(db)
        .filter((r) => r.removedAt === null)
        .map((r) => r.fullName),
      forgeConfigured: config.forge !== null,
    };
  } finally {
    sqlite.close();
  }
}

function info(forge: Map<string, ForgeInfo>, row: { sourceAdapterId: string }): ForgeInfo {
  return forge.get(row.sourceAdapterId) ?? { platform: null, webBaseUrl: null };
}

/** A link, or the same text unlinked when nothing can be addressed. */
function Maybe({ href, children }: { href: string | null; children: React.ReactNode }) {
  if (!href) return <>{children}</>;
  return (
    <a
      className="underline decoration-neutral-300 dark:decoration-neutral-700 hover:decoration-neutral-600"
      href={href}
      target="_blank"
      rel="noreferrer noopener"
    >
      {children}
    </a>
  );
}

/**
 * Merged or closed, as a word first. A colour alone would not say which
 * (NFR-18), and the two are different facts: one landed, one was abandoned.
 */
function Outcome({ state }: { state: CompletedUpdateRow['finalState'] }) {
  const merged = state === 'pr-merged';
  return (
    <span className={merged ? 'text-green-700 dark:text-green-300' : 'text-neutral-500 dark:text-neutral-400'}>
      {merged ? 'merged' : 'closed'}
    </span>
  );
}

/** The repository filter. A plain GET form, as the other list pages use. */
function Filters({ repo, repoNames }: { repo: string | null; repoNames: string[] }) {
  return (
    <form method="get" action="/history" className="mt-6 flex flex-wrap items-end gap-3">
      <div className="flex flex-col">
        <label className="text-xs uppercase tracking-wide text-neutral-500 dark:text-neutral-400" htmlFor="repo">
          Repository
        </label>
        <select
          id="repo"
          name="repo"
          defaultValue={repo ?? ''}
          className="mt-1 rounded border border-neutral-300 dark:border-neutral-700 bg-white text-neutral-900 dark:bg-neutral-900 dark:text-neutral-100 px-2 py-1 text-sm"
        >
          <option value="" className="bg-white text-neutral-900 dark:bg-neutral-900 dark:text-neutral-100">
            the whole fleet
          </option>
          {repoNames.map((name) => (
            <option
              key={name}
              value={name}
              className="bg-white text-neutral-900 dark:bg-neutral-900 dark:text-neutral-100"
            >
              {name}
            </option>
          ))}
        </select>
      </div>
      <button type="submit" className="rounded border border-neutral-300 dark:border-neutral-700 px-3 py-1 text-sm">
        Filter
      </button>
      {repo !== null && (
        <span className="text-sm text-neutral-500 dark:text-neutral-400">
          <a className="underline" href="/history">
            Clear
          </a>
        </span>
      )}
    </form>
  );
}

/**
 * Why the history is empty, which is not the same fact in each case. Withe
 * learns that a pull request merged by reading the forge, so with no token it
 * never records one and an empty page would otherwise read as "Renovate has
 * done nothing".
 */
function Empty({ forgeConfigured, repo }: { forgeConfigured: boolean; repo: string | null }) {
  if (!forgeConfigured) {
    return (
      <p className="mt-6 text-sm text-neutral-500 dark:text-neutral-400">
        No completed updates are recorded, because no GitHub token is set. Withe reads whether a pull
        request merged or closed from the forge, so set <code>WITHE_GITHUB_TOKEN</code> and this page
        fills as Renovate finishes its next updates. It does not backfill what already merged.
      </p>
    );
  }
  if (repo !== null) {
    return (
      <p className="mt-6 text-sm text-neutral-500 dark:text-neutral-400">
        Nothing recorded for {repo} yet. <a className="underline" href="/history">Show the whole fleet</a>.
      </p>
    );
  }
  return (
    <p className="mt-6 text-sm text-neutral-500 dark:text-neutral-400">
      No completed updates are recorded yet. Withe records one when Renovate&rsquo;s pull request
      merges or closes, so this page fills as the fleet moves. What is still queued is on the{' '}
      <a className="underline" href="/updates">pending updates page</a>.
    </p>
  );
}

interface Props {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function History({ searchParams }: Props) {
  const params = await searchParams;
  const repo = readRepoFilter(params);
  const { rows, forge, repoNames, forgeConfigured } = read(repo);
  const groups = groupByDependency(rows, { rows: byNewest, groups: byLatestLanding });
  const counts = tally(rows);
  const repoTotal = new Set(rows.map((r) => r.repoFullName)).size;

  return (
    <main className="mx-auto max-w-4xl p-8">
      <h1 className="text-2xl font-semibold">Completed updates</h1>
      <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
        What Renovate has finished{repo === null ? ' across the fleet' : ` in ${repo}`}:{' '}
        {counts.merged} merged and {counts.closed} closed without merging, across {repoTotal}{' '}
        {repoTotal === 1 ? 'repository' : 'repositories'}. Grouped by dependency and newest first.
        What is still queued is on the <a className="underline" href="/updates">pending updates page</a>.
      </p>

      {(rows.length > 0 || repo !== null) && <Filters repo={repo} repoNames={repoNames} />}

      {rows.length === 0 ? (
        <Empty forgeConfigured={forgeConfigured} repo={repo} />
      ) : (
        <>
          <table className="mt-4 w-full text-sm">
            {groups.map((group) => (
              <tbody key={`${group.dependencyName}/${group.datasource ?? ''}`}>
                <tr>
                  <th colSpan={6} className="pt-6 pb-1 text-left text-sm font-semibold">
                    {group.dependencyName}{' '}
                    <span className="font-normal text-neutral-500 dark:text-neutral-400">
                      ({group.rows.length} {group.rows.length === 1 ? 'update' : 'updates'})
                    </span>
                  </th>
                </tr>
                {group.rows.map((row) => (
                  <tr
                    key={`${row.sourceAdapterId}/${row.repoFullName}/${row.prNumber}`}
                    className="border-t border-neutral-200 dark:border-neutral-800"
                  >
                    <td className="py-1 pr-4 font-medium">
                      <Maybe href={repoUrl(info(forge, row).webBaseUrl, row.repoFullName)}>
                        {row.repoFullName}
                      </Maybe>
                    </td>
                    <td className="py-1 pr-4 tabular-nums text-neutral-600 dark:text-neutral-300">
                      {row.currentVersion} → {row.targetVersion}
                    </td>
                    <td className="py-1 pr-4 text-neutral-500 dark:text-neutral-400">{row.updateType}</td>
                    <td className="py-1 pr-4">
                      <Outcome state={row.finalState} />
                    </td>
                    <td
                      className="py-1 pr-4 tabular-nums text-neutral-500 dark:text-neutral-400"
                      title={row.closedAt?.toISOString() ?? undefined}
                    >
                      {row.closedAt?.toISOString().slice(0, 10) ?? '—'}{' '}
                      <span className="text-neutral-500 dark:text-neutral-400">({ago(row.closedAt, '—')})</span>
                    </td>
                    <td className="py-1 text-neutral-500 dark:text-neutral-400">
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
                    </td>
                  </tr>
                ))}
              </tbody>
            ))}
          </table>
          {rows.length === LIMIT && (
            <p className="mt-4 text-sm text-neutral-500 dark:text-neutral-400">
              The newest {LIMIT} records are shown. Filter by repository to narrow them.
            </p>
          )}
        </>
      )}

      <p className="mt-8 text-sm">
        <a className="underline" href="/">
          Back to the dashboard
        </a>
      </p>
    </main>
  );
}
