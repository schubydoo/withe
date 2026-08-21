import { existsSync } from 'node:fs';

import { redirect } from 'next/navigation';

import { loadConfig } from '../../config/load.ts';
import { repoUrl } from '../../core/links.ts';
import { openDatabase } from '../../db/client.ts';
import { forges, repoInventory, type ForgeInfo, type InventoryRow } from '../../db/queries.ts';
import { ago } from '../format.ts';
import { distinctSources, groupByFullName } from './group.ts';
import { filterRepos, isActive, readFilter, REPO_STATES, repoState, type RepoFilter, type RepoState } from './filter.ts';

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
 * The colour that repeats each state word.
 *
 * NFR-18 forbids conveying status by colour alone, so the word from
 * `repoState` is the signal and this is the second one. Filtering reads the
 * same function, so a row can never be filtered as one state and badged as
 * another.
 */
const TONES: Record<RepoState, string> = {
  removed: 'bg-neutral-200 dark:bg-neutral-800 text-neutral-700 dark:text-neutral-300',
  disabled: 'bg-neutral-100 dark:bg-neutral-800 text-neutral-600 dark:text-neutral-300',
  failing: 'bg-red-100 dark:bg-red-900 text-red-800 dark:text-red-300',
  stalled: 'bg-amber-100 dark:bg-amber-900 text-amber-900 dark:text-amber-200',
  'no runs yet': 'bg-neutral-100 dark:bg-neutral-800 text-neutral-600 dark:text-neutral-300',
  active: 'bg-green-100 dark:bg-green-900 text-green-800 dark:text-green-300',
};

/**
 * The filter control.
 *
 * A plain GET form, so the filter lands in the URL, survives a reload, and
 * works with scripting off. F-09 asks for the filter to be shareable; a form
 * that submits to this same page gives that for free.
 */
function Filters({ filter, shown, total }: { filter: RepoFilter; shown: number; total: number }) {
  return (
    <form method="get" action="/repos" className="mt-6 flex flex-wrap items-end gap-3">
      <div className="flex flex-col">
        <label className="text-xs uppercase tracking-wide text-neutral-500 dark:text-neutral-400" htmlFor="repo-search">
          Search
        </label>
        <input
          id="repo-search"
          name="q"
          type="search"
          defaultValue={filter.q}
          placeholder="org or repository"
          className="mt-1 rounded border border-neutral-300 dark:border-neutral-700 bg-transparent px-2 py-1 text-sm"
        />
      </div>
      <div className="flex flex-col">
        <label className="text-xs uppercase tracking-wide text-neutral-500 dark:text-neutral-400" htmlFor="repo-state">
          State
        </label>
        <select
          id="repo-state"
          name="state"
          defaultValue={filter.state ?? ''}
          className="mt-1 rounded border border-neutral-300 dark:border-neutral-700 bg-transparent px-2 py-1 text-sm"
        >
          <option value="">any</option>
          {REPO_STATES.map((state) => (
            <option key={state} value={state}>
              {state}
            </option>
          ))}
        </select>
      </div>
      <button
        type="submit"
        className="rounded border border-neutral-300 dark:border-neutral-700 px-3 py-1 text-sm"
      >
        Filter
      </button>
      {isActive(filter) && (
        <span className="text-sm text-neutral-500 dark:text-neutral-400">
          <a className="underline" href="/repos">
            Clear
          </a>
          <span className="ml-3 tabular-nums">
            {shown} of {total} shown
          </span>
        </span>
      )}
    </form>
  );
}

interface Props {
  // Next hands every query key through as `string | string[]`, and the source
  // filter and the search/state filter share this query string, so it is read
  // wide and each filter narrows what it needs.
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
  const { rows, forge } = read();
  // Source filter (Task 4.4), applied before grouping.
  const sources = distinctSources(rows);
  const rawSource = Array.isArray(params.source) ? params.source.at(-1) : params.source;
  const source = typeof rawSource === 'string' && sources.includes(rawSource) ? rawSource : null;
  const grouped = groupByFullName(source ? rows.filter((r) => r.sourceAdapterId === source) : rows);
  // Search/state filter (Task 4.7), applied to each group's primary so the
  // group structure (contributors, pending count) survives the filter.
  const filter = readFilter(params);
  const shownGroups = grouped.filter((g) => filterRepos([g.primary], filter).length > 0);
  const shown = shownGroups.map((g) => g.primary);
  const orgs = [...new Set(shown.map((r) => r.org))];
  const removed = shown.filter((r) => r.removedAt).length;

  return (
    <main className="mx-auto max-w-5xl p-8">
      <h1 className="text-2xl font-semibold">Repositories</h1>
      <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
        {shown.length} across {orgs.length} {orgs.length === 1 ? 'organization' : 'organizations'}
        {removed > 0 && `, ${removed} removed at the source and kept for their history`}
      </p>

      {rows.length > 0 && <Filters filter={filter} shown={shown.length} total={grouped.length} />}

      {sources.length > 1 && (
        // Only a multi-source install is offered the source filter: with one
        // source the labels would name the same thing on every row (Task 4.4).
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
          {isActive(filter) ? 'The repositories matching this filter' : 'Every repository Withe knows about'}, with its state and most recent run.
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
          {shownGroups.map(({ primary: row, rows: group, sources: contributors }) => {
            const label = repoState(row);
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
                  <span className={`rounded px-1.5 py-0.5 text-xs ${TONES[label]}`}>{label}</span>
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

      {rows.length === 0 && (
        <p className="mt-4 text-sm text-neutral-500 dark:text-neutral-400">
          No repositories yet. The <a className="underline" href="/preflight">setup check</a> says
          why.
        </p>
      )}

      {rows.length > 0 && shown.length === 0 && (
        <p className="mt-4 text-sm text-neutral-500 dark:text-neutral-400">
          No repository matches this filter. <a className="underline" href="/repos">Show all {grouped.length}</a>.
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
