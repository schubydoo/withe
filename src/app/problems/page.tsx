import { existsSync } from 'node:fs';

import { redirect } from 'next/navigation';

import { loadConfig } from '../../config/load.ts';
import { openDatabase } from '../../db/client.ts';
import {
  problemIndexSize,
  searchProblems,
  type LogProblemRow,
  type ProblemIndexSize,
} from '../../db/queries.ts';
import { ago } from '../format.ts';
import {
  isActive,
  PROBLEM_LEVELS,
  readProblemFilter,
  rowKey,
  type ProblemFilter,
} from './filter.ts';

export const dynamic = 'force-dynamic';

/** How many matches the page renders. A fleet in trouble writes more than a page. */
const LIMIT = 200;

interface PageData {
  rows: LogProblemRow[];
  size: ProblemIndexSize;
}

function read(filter: ProblemFilter): PageData {
  const config = loadConfig();
  if (config.sources.length === 0 || !existsSync(config.dbPath)) redirect('/preflight');

  const { sqlite, db } = openDatabase(config.dbPath);
  try {
    return {
      rows: searchProblems(db, {
        query: filter.query ?? undefined,
        level: filter.level ?? undefined,
        limit: LIMIT,
      }),
      size: problemIndexSize(db),
    };
  } finally {
    sqlite.close();
  }
}

/**
 * The level as a word first. A colour alone would not say which level it is
 * (NFR-18), and the three are different facts: Renovate carried on after a
 * warning and stopped at a fatal.
 */
function Level({ level }: { level: LogProblemRow['level'] }) {
  const tone =
    level === 'fatal'
      ? 'text-red-700 dark:text-red-300'
      : level === 'error'
        ? 'text-orange-700 dark:text-orange-300'
        : 'text-amber-700 dark:text-amber-300';
  return <span className={tone}>{level}</span>;
}

/** The search. A plain GET form, as the other list pages use. */
function Filters({ filter }: { filter: ProblemFilter }) {
  return (
    <form method="get" action="/problems" className="mt-6 flex flex-wrap items-end gap-3">
      <div className="flex flex-col">
        <label
          className="text-xs uppercase tracking-wide text-neutral-500 dark:text-neutral-400"
          htmlFor="q"
        >
          Text
        </label>
        <input
          id="q"
          name="q"
          type="search"
          defaultValue={filter.query ?? ''}
          placeholder="ExternalHostError"
          className="mt-1 w-72 rounded border border-neutral-300 dark:border-neutral-700 bg-white text-neutral-900 dark:bg-neutral-900 dark:text-neutral-100 px-2 py-1 text-sm"
        />
      </div>
      <div className="flex flex-col">
        <label
          className="text-xs uppercase tracking-wide text-neutral-500 dark:text-neutral-400"
          htmlFor="level"
        >
          Level
        </label>
        <select
          id="level"
          name="level"
          defaultValue={filter.level ?? ''}
          className="mt-1 rounded border border-neutral-300 dark:border-neutral-700 bg-white text-neutral-900 dark:bg-neutral-900 dark:text-neutral-100 px-2 py-1 text-sm"
        >
          <option value="" className="bg-white text-neutral-900 dark:bg-neutral-900 dark:text-neutral-100">
            every level
          </option>
          {PROBLEM_LEVELS.map((level) => (
            <option
              key={level}
              value={level}
              className="bg-white text-neutral-900 dark:bg-neutral-900 dark:text-neutral-100"
            >
              {level} and worse
            </option>
          ))}
        </select>
      </div>
      <button
        type="submit"
        className="rounded border border-neutral-300 dark:border-neutral-700 px-3 py-1 text-sm"
      >
        Search
      </button>
      {isActive(filter) && (
        <span className="text-sm text-neutral-500 dark:text-neutral-400">
          <a className="underline" href="/problems">
            Clear
          </a>
        </span>
      )}
    </form>
  );
}

/**
 * Why there is nothing to show, which is not the same fact in each case.
 *
 * An empty index and an empty search read alike and mean opposite things: one
 * says Withe has nothing to search, the other says the fleet wrote no line
 * like that. The operator who runs no Dependency Dashboard has nowhere else to
 * look, so each case says what it is.
 */
function Empty({ size }: { size: ProblemIndexSize }) {
  if (size.lines === 0) {
    return (
      <p className="mt-6 text-sm text-neutral-500 dark:text-neutral-400">
        Withe has no problem lines yet. It keeps the warn-level and worse lines of each log it
        reads, which is each repository&apos;s newest finished run at each sync, so this page fills
        as Renovate runs. A fleet whose runs all pass writes none at all, which is the good case.
      </p>
    );
  }
  return (
    <p className="mt-6 text-sm text-neutral-500 dark:text-neutral-400">
      No problem line matches. Withe holds {size.lines} {size.lines === 1 ? 'line' : 'lines'} from{' '}
      {size.runs} {size.runs === 1 ? 'run' : 'runs'}, so this says nothing matched rather than that
      the fleet is quiet. <a className="underline" href="/problems">Show them all</a>.
    </p>
  );
}

interface Props {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function Problems({ searchParams }: Props) {
  const params = await searchParams;
  const filter = readProblemFilter(params);
  const { rows, size } = read(filter);
  // At the cap the page shows a window on the matches, not all of them, so the
  // wording below says so rather than reading as a total.
  const capped = rows.length === LIMIT;

  return (
    <main className="mx-auto max-w-4xl p-8">
      <h1 className="text-2xl font-semibold">Log problems</h1>
      <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
        Search the warn-level and worse lines of every repository&apos;s runs, newest first. Withe
        does not store whole logs, so this searches those lines and nothing else. A whole log is on
        its own run page.
        {size.lines > 0 && (
          <>
            {' '}
            Withe holds {size.lines} {size.lines === 1 ? 'line' : 'lines'} from {size.runs}{' '}
            {size.runs === 1 ? 'run' : 'runs'}.
          </>
        )}
      </p>

      <Filters filter={filter} />

      {rows.length === 0 ? (
        <Empty size={size} />
      ) : (
        <>
          <p className="mt-4 text-sm text-neutral-500 dark:text-neutral-400">
            {capped ? `The newest ${LIMIT} matching lines` : `${rows.length} matching ${rows.length === 1 ? 'line' : 'lines'}`}
            {filter.query === null ? '' : ` for “${filter.query}”`}
            {filter.level === null ? '' : `, at ${filter.level} and worse`}.
          </p>
          <table className="mt-2 w-full text-sm">
            <caption className="sr-only">
              Problem lines from Renovate run logs, newest first. Each row gives the repository, the
              level, the line, how many times the run wrote it, when it was written, and a link to
              the run.
            </caption>
            <tbody>
              {rows.map((row) => (
                <tr key={rowKey(row)} className="border-t border-neutral-200 dark:border-neutral-800 align-top">
                  <td className="py-1 pr-4 font-medium whitespace-nowrap">{row.repoFullName}</td>
                  <td className="py-1 pr-4 whitespace-nowrap">
                    <Level level={row.level} />
                  </td>
                  <td className="py-1 pr-4 font-mono text-xs break-all text-neutral-700 dark:text-neutral-300">
                    {row.message}
                    {row.occurrences > 1 && (
                      <span className="ml-1 font-sans text-neutral-500 dark:text-neutral-400">
                        ×{row.occurrences} in this run
                      </span>
                    )}
                  </td>
                  <td
                    className="py-1 pr-4 tabular-nums whitespace-nowrap text-neutral-500 dark:text-neutral-400"
                    title={row.at?.toISOString() ?? undefined}
                  >
                    {ago(row.at, '—')}
                  </td>
                  <td className="py-1 whitespace-nowrap">
                    <a className="underline" href={`/runs/${row.runId}`}>
                      the run
                    </a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {capped && (
            <p className="mt-4 text-sm text-neutral-500 dark:text-neutral-400">
              Older matches are kept but not shown here. Narrow the search to reach them.
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
