/**
 * The sync loop.
 *
 * A timer, not a queue. Every dependency it needs is passed in — the clock, the
 * logger, the adapters — so a test can drive years of cycles in milliseconds
 * without a server or a real interval.
 */
import type { SourceAdapter } from '../adapters/types.ts';
import type { openDatabase } from '../db/client.ts';
import { persist, recomputeStalled, recordSyncFailure } from '../db/persist.ts';

type Db = ReturnType<typeof openDatabase>['db'];

export interface SyncOptions {
  intervalMs: number;
  stalledAfterMs: number;
  /** Injectable so tests do not wait. Defaults to the wall clock. */
  now?: () => number;
  log?: (message: string) => void;
}

export interface SourceOutcome {
  sourceAdapterId: string;
  outcome: 'ok' | 'partial' | 'failed' | 'backoff';
  repos: number;
  runs: number;
  updates: number;
  error?: string;
  /** When this source will be tried again, if it is backing off. */
  retryAt?: number;
}

export interface CycleReport {
  skipped: boolean;
  sources: SourceOutcome[];
}

/**
 * How long to wait after `failures` consecutive failures.
 *
 * Doubling from 1 second, capped at the sync interval. Section 4.3 is explicit
 * that Withe never hammers a server that is down, and the cap matters as much
 * as the growth: without it a source that failed overnight would not be retried
 * for days.
 */
export function backoffMs(failures: number, intervalMs: number): number {
  if (failures < 1) return 0;
  const grown = 1000 * 2 ** (failures - 1);
  return Math.min(grown, intervalMs);
}

export class SyncLoop {
  private running = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly failures = new Map<string, number>();
  private readonly retryAt = new Map<string, number>();
  private readonly now: () => number;
  private readonly log: (message: string) => void;

  private readonly db: Db;
  private readonly adapters: readonly SourceAdapter[];
  private readonly options: SyncOptions;

  // Fields are assigned explicitly rather than declared as constructor
  // parameter properties. Node runs TypeScript by stripping types, and a
  // parameter property is a syntax transform rather than a type annotation, so
  // `node --test` rejects it outright — while Next's compiler accepts it. Code
  // that only the web build exercises would look fine and break the tests.
  constructor(db: Db, adapters: readonly SourceAdapter[], options: SyncOptions) {
    this.db = db;
    this.adapters = adapters;
    this.options = options;
    this.now = options.now ?? (() => Date.now());
    this.log = options.log ?? ((message) => console.log(message));
  }

  /** Whether a cycle is in flight. Exposed for the health check in Task 3.6. */
  get busy(): boolean {
    return this.running;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.runCycle();
    }, this.options.intervalMs);
    // The timer must not hold the process open on its own; the supervisor in
    // Task 2.2 decides when this exits.
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * Run one cycle over every source.
   *
   * A cycle already in flight causes this tick to be dropped rather than
   * queued. Piling up would turn one slow source into an ever-growing backlog
   * of overlapping passes over the same data.
   */
  async runCycle(): Promise<CycleReport> {
    if (this.running) {
      this.log('sync: a cycle is still running, skipping this tick');
      return { skipped: true, sources: [] };
    }

    this.running = true;
    try {
      const sources: SourceOutcome[] = [];
      for (const adapter of this.adapters) {
        sources.push(await this.syncOne(adapter));
      }
      return { skipped: false, sources };
    } finally {
      this.running = false;
    }
  }

  private async syncOne(adapter: SourceAdapter): Promise<SourceOutcome> {
    const id = adapter.id;
    const waitUntil = this.retryAt.get(id) ?? 0;
    if (this.now() < waitUntil) {
      return { sourceAdapterId: id, outcome: 'backoff', repos: 0, runs: 0, updates: 0, retryAt: waitUntil };
    }

    const startedAt = new Date(this.now());
    try {
      const result = await adapter.collect();
      // One transaction per source. A source that fails halfway leaves the
      // store as it was rather than half updated.
      const counts = persist(this.db, id, adapter.kind, result, startedAt);
      recomputeStalled(this.db, id, new Date(this.now() - this.options.stalledAfterMs));

      this.failures.delete(id);
      this.retryAt.delete(id);
      for (const warning of result.warnings) this.log(`sync ${id}: ${warning}`);

      return {
        sourceAdapterId: id,
        outcome: result.warnings.length > 0 ? 'partial' : 'ok',
        ...counts,
      };
    } catch (cause) {
      // A failing source must not stop the others, so this is caught per source
      // rather than around the cycle.
      const error = cause instanceof Error ? cause.message : String(cause);
      const failures = (this.failures.get(id) ?? 0) + 1;
      this.failures.set(id, failures);
      const wait = backoffMs(failures, this.options.intervalMs);
      const retryAt = this.now() + wait;
      this.retryAt.set(id, retryAt);

      recordSyncFailure(this.db, id, adapter.kind, startedAt, error);
      this.log(`sync ${id}: failed (${failures} in a row), retrying in ${Math.round(wait / 1000)}s: ${error}`);

      return { sourceAdapterId: id, outcome: 'failed', repos: 0, runs: 0, updates: 0, error, retryAt };
    }
  }
}
