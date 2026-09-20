/**
 * The fleet-wide problem search: what its query string means (B-4).
 *
 * The page renders what these functions decide, so a test reaches the reading
 * rules without rendering anything, the same split the other list pages use.
 */
import type { ProblemLevel } from '../../core/renovate-log.ts';
import type { LogProblemRow } from '../../db/queries.ts';

/** The levels the control offers, worst first. */
export const PROBLEM_LEVELS: readonly ProblemLevel[] = ['fatal', 'error', 'warn'];

export interface ProblemFilter {
  /** Null means every line, which is the landing state. */
  query: string | null;
  /** Null means every level. */
  level: ProblemLevel | null;
}

export const NO_PROBLEM_FILTER: ProblemFilter = { query: null, level: null };

/** What Next.js hands a page for one query-string key. */
type Param = string | string[] | undefined;

/** `?q=a&q=b` arrives as an array; read the last, as a resubmit leaves it. */
function one(value: Param): string | undefined {
  return Array.isArray(value) ? value.at(-1) : value;
}

/**
 * Read the search from the query string.
 *
 * A blank search is the same as none, so submitting the empty form lists the
 * most recent lines rather than searching for nothing. An unknown level is
 * dropped rather than rejected, so a hand-edited URL shows every level rather
 * than an error page.
 */
export function readProblemFilter(params: { q?: Param; level?: Param }): ProblemFilter {
  const raw = one(params.q)?.trim();
  const level = one(params.level);
  return {
    query: raw === undefined || raw === '' ? null : raw,
    level: (PROBLEM_LEVELS as readonly string[]).includes(level ?? '')
      ? (level as ProblemLevel)
      : null,
  };
}

export function isActive(filter: ProblemFilter): boolean {
  return filter.query !== null || filter.level !== null;
}

/**
 * What makes one line distinct from another, as a string.
 *
 * Persist rewrites a run's lines together and folds its repeats into one row,
 * so a run holds one row per level and message. Those three name the row, and
 * the same line in two runs is two rows that must not share a key.
 *
 * The unit separator joins the parts, as it does elsewhere in the store,
 * because it cannot occur in any of them.
 */
export function rowKey(row: LogProblemRow): string {
  return [row.runId, row.level, row.message].join('');
}
