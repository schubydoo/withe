/**
 * Which repositories a filter leaves on screen (Task 4.7).
 *
 * At eight repositories the list is scannable. At two hundred it is not, and
 * F-09 asks for the two questions an operator actually has: "which ones are
 * broken" and "where is that repo". Both answers are computed here rather than
 * in the page, so the state a row is filtered by is by construction the same
 * state its badge shows — one function decides, and the tests can reach it
 * without rendering anything.
 *
 * Filtering runs in memory over the rows the page already loaded. The inventory
 * query returns every repository in one pass, so a SQL `where` would save no
 * work and would split the state rule across two languages.
 */

/** The state of one repository, as the word the badge shows. */
export type RepoState = 'removed' | 'disabled' | 'failing' | 'stalled' | 'no runs yet' | 'active';

/** The fields the state rule reads, and nothing else. */
export interface StatefulRow {
  removedAt: Date | null;
  enabled: boolean;
  stalled: boolean;
  lastRunStatus: string | null;
}

/** The fields the text search reads. */
export interface NamedRow {
  org: string;
  name: string;
}

/**
 * The state rule, in one place.
 *
 * Order matters: a removed repository is also disabled, and a failing one may
 * also be stalled. The first match wins, most decisive first.
 */
export function repoState(row: StatefulRow): RepoState {
  if (row.removedAt) return 'removed';
  if (!row.enabled) return 'disabled';
  if (row.lastRunStatus === 'failed') return 'failing';
  if (row.stalled) return 'stalled';
  if (row.lastRunStatus === null) return 'no runs yet';
  return 'active';
}

/** Every state, in the order the filter control offers them. */
export const REPO_STATES: readonly RepoState[] = [
  'active',
  'failing',
  'stalled',
  'no runs yet',
  'disabled',
  'removed',
];

export interface RepoFilter {
  /** Trimmed search text. Empty means no text filter. */
  q: string;
  /** Null means every state. */
  state: RepoState | null;
}

export const NO_FILTER: RepoFilter = { q: '', state: null };

/** What Next.js hands a page for one query-string key. */
type Param = string | string[] | undefined;

/** `?q=a&q=b` arrives as an array. Read the last one, the way a form resubmit
 * would leave it, rather than throwing on a URL anyone can type. */
function one(value: Param): string | undefined {
  if (Array.isArray(value)) return value.at(-1);
  return value;
}

/**
 * Read the filter out of the query string.
 *
 * An unrecognised state is dropped rather than rejected: a stale bookmark or a
 * hand-edited URL should show the whole list, not an error page.
 */
export function readFilter(params: { q?: Param; state?: Param }): RepoFilter {
  const q = (one(params.q) ?? '').trim();
  const raw = one(params.state);
  const state = raw !== undefined && (REPO_STATES as readonly string[]).includes(raw)
    ? (raw as RepoState)
    : null;
  return { q, state };
}

/** True when the filter would change what is on screen. */
export function isActive(filter: RepoFilter): boolean {
  return filter.q !== '' || filter.state !== null;
}

/** Matches org, name, or the `org/name` form the operator sees on the page. */
export function matchesQuery(row: NamedRow, q: string): boolean {
  if (q === '') return true;
  const needle = q.toLowerCase();
  return (
    row.org.toLowerCase().includes(needle) ||
    row.name.toLowerCase().includes(needle) ||
    `${row.org}/${row.name}`.toLowerCase().includes(needle)
  );
}

export function filterRepos<T extends StatefulRow & NamedRow>(rows: T[], filter: RepoFilter): T[] {
  if (!isActive(filter)) return rows;
  return rows.filter(
    (row) =>
      matchesQuery(row, filter.q) && (filter.state === null || repoState(row) === filter.state),
  );
}
