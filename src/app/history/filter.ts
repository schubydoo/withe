/**
 * The completed-update history: its ordering and its repository filter (B-10).
 *
 * The pending view groups by dependency and reads alphabetically, because
 * nothing there has happened yet. A history has a time axis, so it groups the
 * same way and orders by when each update landed. Both orderings are pure and
 * live here, so the page renders what these functions decide and the tests
 * reach them without rendering anything.
 */
import type { CompletedUpdateRow } from '../../db/queries.ts';
import type { DependencyGroup } from '../updates/filter.ts';

/** What Next.js hands a page for one query-string key. */
type Param = string | string[] | undefined;

/** `?repo=a&repo=b` arrives as an array; read the last, as a resubmit leaves it. */
function one(value: Param): string | undefined {
  return Array.isArray(value) ? value.at(-1) : value;
}

/**
 * Read the repository filter from the query string. An empty value is the same
 * as none, so submitting the form with nothing chosen shows the whole fleet
 * rather than a repository named the empty string.
 */
export function readRepoFilter(params: { repo?: Param }): string | null {
  const raw = one(params.repo)?.trim();
  return raw === undefined || raw === '' ? null : raw;
}

/** When a row landed, as a number. A row with no date sorts oldest. */
function landedAt(row: CompletedUpdateRow): number {
  return row.closedAt?.getTime() ?? 0;
}

/** Newest first, then by repository so two updates landing together are stable. */
export function byNewest(a: CompletedUpdateRow, b: CompletedUpdateRow): number {
  return landedAt(b) - landedAt(a) || a.repoFullName.localeCompare(b.repoFullName);
}

/**
 * Dependencies by their most recent landing, newest first. The rows are already
 * sorted when this runs, so the first row of each group is its newest.
 */
export function byLatestLanding(
  a: DependencyGroup<CompletedUpdateRow>,
  b: DependencyGroup<CompletedUpdateRow>,
): number {
  const left = a.rows[0];
  const right = b.rows[0];
  return (
    (right ? landedAt(right) : 0) - (left ? landedAt(left) : 0) ||
    a.dependencyName.localeCompare(b.dependencyName)
  );
}

/** How many of these updates landed, and how many Renovate closed unmerged. */
export function tally(rows: CompletedUpdateRow[]): { merged: number; closed: number } {
  let merged = 0;
  for (const row of rows) if (row.finalState === 'pr-merged') merged += 1;
  return { merged, closed: rows.length - merged };
}
