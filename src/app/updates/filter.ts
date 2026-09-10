/**
 * The cross-repo pending-updates view: its type filter and its grouping (Task
 * 5.5, F-11).
 *
 * The dashboard groups pending updates by repository; this page inverts that and
 * groups them by dependency, so an operator sees every repository awaiting the
 * same update on one line. Both the filter and the grouping are pure and live
 * here, so the page renders what these functions decide and the tests reach them
 * without rendering anything.
 */
import type { UpdateType } from '../../core/model.ts';
import type { PendingUpdateRow } from '../../db/queries.ts';

/**
 * The update types the view offers, most decisive first. `lock-file-maintenance`
 * is not here: `pendingUpdates` excludes it because it names no dependency, so it
 * never reaches this page.
 */
export const UPDATE_TYPES: readonly UpdateType[] = [
  'security',
  'major',
  'multiple-major',
  'minor',
  'patch',
  'digest',
];

export interface UpdateFilter {
  /** Null means every type. */
  type: UpdateType | null;
}

export const NO_UPDATE_FILTER: UpdateFilter = { type: null };

/** What Next.js hands a page for one query-string key. */
type Param = string | string[] | undefined;

/** `?type=a&type=b` arrives as an array; read the last, the way a resubmit leaves it. */
function one(value: Param): string | undefined {
  return Array.isArray(value) ? value.at(-1) : value;
}

/**
 * Read the type filter from the query string. An unknown type is dropped rather
 * than rejected, so a stale bookmark or a hand-edited URL shows the whole list
 * rather than an error page.
 */
export function readUpdateFilter(params: { type?: Param }): UpdateFilter {
  const raw = one(params.type);
  const type =
    raw !== undefined && (UPDATE_TYPES as readonly string[]).includes(raw) ? (raw as UpdateType) : null;
  return { type };
}

export function isActive(filter: UpdateFilter): boolean {
  return filter.type !== null;
}

export function filterByType(rows: PendingUpdateRow[], filter: UpdateFilter): PendingUpdateRow[] {
  return filter.type === null ? rows : rows.filter((row) => row.updateType === filter.type);
}

/** One dependency and every repository awaiting it. */
export interface DependencyGroup {
  dependencyName: string;
  datasource: string | null;
  packageName: string | null;
  rows: PendingUpdateRow[];
}

/**
 * Group pending updates by dependency, across repositories. The key is the
 * dependency name and its datasource, so an npm `node` and a Docker `node` stay
 * apart; a JSON pair is the key so no name or datasource value can collide with
 * a separator. Groups come back sorted by dependency name, and the rows inside
 * each by repository, so the page's order is stable without sorting in the view.
 */
export function groupByDependency(rows: PendingUpdateRow[]): DependencyGroup[] {
  const groups = new Map<string, DependencyGroup>();
  for (const row of rows) {
    const key = JSON.stringify([row.dependencyName, row.datasource]);
    const group = groups.get(key);
    if (group) {
      group.rows.push(row);
    } else {
      groups.set(key, {
        dependencyName: row.dependencyName,
        datasource: row.datasource,
        packageName: row.packageName,
        rows: [row],
      });
    }
  }
  const sorted = [...groups.values()].sort((a, b) => a.dependencyName.localeCompare(b.dependencyName));
  for (const group of sorted) group.rows.sort((a, b) => a.repoFullName.localeCompare(b.repoFullName));
  return sorted;
}
