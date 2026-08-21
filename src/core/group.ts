/**
 * One repository on screen, however many sources describe it (Task 4.4, Q-7).
 *
 * A server API and a log directory can both watch the same runner, so the same
 * `org/name` arrives once per source. Listing it twice reads as two
 * repositories; a page groups by full name and names the contributors instead.
 * Grouping happens at display time — the rows stay separate in the database,
 * keyed by source. Q-7 is closed on that basis (Task 4.8): display-time
 * grouping, no write-time merge, so provenance and per-source health survive.
 *
 * Lives in core because both the inventory (/repos) and the dashboard read it.
 */

/** The fields grouping reads. A page's row type satisfies this. */
export interface SourcedRow {
  sourceAdapterId: string;
  fullName: string;
  lastRunAt: Date | null;
  /** Absent on rows a query already filters to the living, present elsewhere. */
  removedAt?: Date | null;
}

export interface Grouped<T extends SourcedRow> {
  /** The row whose facts the page shows: the one with the newest run. */
  primary: T;
  /** Every contributing row, for facts one contributor has and another lacks
   * — a pending count, a forge link. */
  rows: T[];
  /** Every source that contributed this repository, sorted for stable output. */
  sources: string[];
}

/**
 * Group rows by full name, one entry per repository.
 *
 * The primary is the row with the newest run — the freshest observer wins,
 * which is the same rule the pending-updates extractor applies to runs. A
 * repository removed at one source but alive at another is alive: `removedAt`
 * counts only when every contributor says so, so the primary prefers a living
 * row over a fresher removed one.
 */
export function groupByFullName<T extends SourcedRow>(rows: T[]): Grouped<T>[] {
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    const group = groups.get(row.fullName);
    if (group) group.push(row);
    else groups.set(row.fullName, [row]);
  }

  return [...groups.values()].map((group) => {
    const living = group.filter((row) => !row.removedAt);
    const candidates = living.length > 0 ? living : group;
    let primary = candidates[0] as T;
    for (const row of candidates) {
      if ((row.lastRunAt?.getTime() ?? 0) > (primary.lastRunAt?.getTime() ?? 0)) primary = row;
    }
    return { primary, rows: group, sources: group.map((row) => row.sourceAdapterId).sort() };
  });
}

/** Distinct source ids across the whole inventory, for deciding whether the
 * source is worth a column at all. One source needs no labels. */
export function distinctSources(rows: readonly { sourceAdapterId: string }[]): string[] {
  return [...new Set(rows.map((row) => row.sourceAdapterId))].sort();
}

/**
 * Drop rows a second source repeats: the same update or refresh, seen once per
 * source that watches the repository (Q-7, Task 4.8). Two sources compute the
 * same pending state, so the copies are equal for display and identity — not
 * source — decides which to keep. The first wins, and the caller's order holds.
 */
export function dedupeBy<T>(rows: readonly T[], identity: (row: T) => string): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const row of rows) {
    const id = identity(row);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(row);
  }
  return out;
}
