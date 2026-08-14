/**
 * Is Withe working, or only running? (Task 3.6, `tad.md` Section 7.1.)
 *
 * A plain HTTP check answers the second question. The web process serves
 * pages happily while the worker is dead, and the pages it serves look right —
 * they show yesterday's data with no sign that it is yesterday's. The rule
 * below is what turns that into a failure.
 */

export interface SourceState {
  sourceAdapterId: string;
  lastSuccessAt: Date | null;
}

export type HealthStatus = 'ok' | 'never-synced' | 'stale';

export interface Health {
  status: HealthStatus;
  /** How long ago the freshest source last succeeded. */
  ageSeconds: number | null;
  /** Sources with nothing recent, named so the reader knows which one to look at. */
  stale: string[];
}

/**
 * Three intervals, not one.
 *
 * One interval would fail on every cycle that runs a second late, and an
 * operator who sees a red container for a slow sync stops reading the colour.
 * Three is late enough to mean something and early enough to catch a worker
 * that died an hour ago.
 */
export const STALE_AFTER_INTERVALS = 3;

export function assess(
  sources: readonly SourceState[],
  intervalSeconds: number,
  now: Date = new Date(),
): Health {
  const limit = intervalSeconds * STALE_AFTER_INTERVALS;
  const ages = sources.map((source) =>
    source.lastSuccessAt === null
      ? null
      : Math.floor((now.getTime() - source.lastSuccessAt.getTime()) / 1000),
  );

  const known = ages.filter((age): age is number => age !== null);
  const ageSeconds = known.length > 0 ? Math.min(...known) : null;

  // A source that has never synced is not stale, it is unstarted, and the two
  // want different words: one is a broken worker, the other is a first run or
  // an unreachable server.
  if (sources.length === 0 || known.length === 0) {
    return { status: 'never-synced', ageSeconds: null, stale: sources.map((s) => s.sourceAdapterId) };
  }

  const stale = sources
    .filter((_source, index) => {
      const age = ages[index] ?? null;
      return age === null || age > limit;
    })
    .map((source) => source.sourceAdapterId);

  return { status: stale.length > 0 ? 'stale' : 'ok', ageSeconds, stale };
}

/** 200 while Withe is telling the truth about fresh data; 503 otherwise. */
export function statusCodeFor(status: HealthStatus): number {
  return status === 'ok' ? 200 : 503;
}
