/**
 * The sync loop.
 *
 * A timer, not a queue. Every dependency it needs is passed in — the clock, the
 * logger, the adapters — so a test can drive years of cycles in milliseconds
 * without a server or a real interval.
 */
import type { CollectResult, SourceAdapter } from '../adapters/types.ts';
import { redact } from '../core/redact.ts';
import { cutMessage } from '../core/renovate-log.ts';
import type { Db } from '../db/client.ts';
import {
  persist,
  pruneCompletedUpdates,
  pruneOldRuns,
  reconcileSources,
  recomputeStalled,
  recordSyncFailure,
} from '../db/persist.ts';

export interface SyncOptions {
  intervalMs: number;
  stalledAfterMs: number;
  /** Injectable so tests do not wait. Defaults to the wall clock. */
  now?: () => number;
  log?: (message: string) => void;
  /**
   * Configured values that must never be stored or printed. NFR-8: an upstream
   * failure message is the one path by which a credential reaches a column.
   */
  secrets?: readonly string[];
  /**
   * Delete run metadata older than this at the end of each cycle. Unset keeps
   * every run forever, which is the default (PRD Section 6.3.1).
   */
  retentionMs?: number;
  /**
   * Refresh pull-request state from the forge before persist, in place, and
   * return any warnings. Unset when no GitHub token is configured, which leaves
   * the worker reading state from the job log alone. Injected so a test drives
   * it without a network.
   */
  enrichForge?: (result: CollectResult) => Promise<string[]>;
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
  /** Sources that left the configuration and were marked removed this cycle. */
  removedSources: number;
  /** Runs deleted by retention at the end of this cycle. */
  pruned: number;
  /** Completed updates deleted by retention at the end of this cycle. */
  prunedUpdates: number;
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

/**
 * Redact each problem line, then cut it to length, before it is stored
 * (B-4, NFR-8).
 *
 * These lines are kept, unlike the logs they come from, so they get the same
 * treatment as a warning that lands in `sync_status.error`. A Renovate log
 * quotes the URLs it fetched and a registry URL can carry a credential. The
 * patterns apply with no configured secret at all, so this runs on every
 * cycle rather than only on a configured one.
 *
 * **The order is the point, not a detail.** `redact` recognises a credential in
 * a URL by the `@` that follows it, so a line cut first can lose that `@` and
 * keep the password in full. Both steps live here, one after the other, so
 * nothing can store a line that met only one of them.
 */
function redactProblems(result: CollectResult, secrets: readonly string[]): void {
  for (const entry of result.problems ?? []) {
    for (const line of entry.problems) line.message = cutMessage(redact(line.message, secrets));
  }
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
      return { skipped: true, sources: [], removedSources: 0, pruned: 0, prunedUpdates: 0 };
    }

    this.running = true;
    try {
      // First, before any source is read. A source the operator deleted from
      // the configuration is never synced again, so nothing else would ever
      // notice it went: this is the only place that reconciles the stored
      // sources against the configured ones. Running it first means a deleted
      // source stops being shown even on a cycle where every configured source
      // fails.
      const removedSources = reconcileSources(
        this.db,
        this.adapters.map((adapter) => adapter.id),
      );
      if (removedSources > 0) {
        this.log(
          `sync: ${removedSources} source(s) left the configuration; their repositories are marked removed`,
        );
      }

      const sources: SourceOutcome[] = [];
      for (const adapter of this.adapters) {
        sources.push(await this.syncOne(adapter));
      }
      // Once per cycle, after every source is written, because pruning touches
      // the whole file rather than one source's rows.
      const pruned = this.prune();
      return {
        skipped: false,
        sources,
        removedSources,
        pruned: pruned.runs,
        prunedUpdates: pruned.updates,
      };
    } finally {
      this.running = false;
    }
  }

  /**
   * Delete runs and completed updates past the retention window. A no-op when
   * it is unset, which is the default: both are kept indefinitely (PRD Section
   * 6.3.1). The two streams share one window so an operator who sets it gets
   * one answer for everything that grows with fleet activity.
   */
  private prune(): { runs: number; updates: number } {
    if (this.options.retentionMs === undefined) return { runs: 0, updates: 0 };
    const cutoff = new Date(this.now() - this.options.retentionMs);
    const runs = pruneOldRuns(this.db, cutoff);
    if (runs > 0) this.log(`sync: pruned ${runs} runs older than the retention window`);
    const updates = pruneCompletedUpdates(this.db, cutoff);
    if (updates > 0) {
      this.log(`sync: pruned ${updates} completed updates older than the retention window`);
    }
    return { runs, updates };
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

      // Read live pull-request state before persist, when a forge is
      // configured. Wrapped so a forge fault degrades to a warning: the log's
      // data is still worth writing, and enrichment is an enhancement, not a
      // precondition.
      if (this.options.enrichForge) {
        try {
          const forgeWarnings = await this.options.enrichForge(result);
          // Redacted like the catch below and like every other warning: these
          // land in sync_status.error through persist, so a credential must not
          // ride an upstream message into a column (NFR-8).
          for (const warning of forgeWarnings) {
            result.warnings.push(redact(warning, this.options.secrets ?? []));
          }
        } catch (cause) {
          result.warnings.push(
            `forge enrichment failed: ${redact(
              cause instanceof Error ? cause.message : String(cause),
              this.options.secrets ?? [],
            )}`,
          );
        }
      }

      redactProblems(result, this.options.secrets ?? []);

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
      // Redacted before it is written, logged or returned. The console filter
      // covers the log line; nothing covers the column but this.
      const error = redact(
        cause instanceof Error ? cause.message : String(cause),
        this.options.secrets ?? [],
      );
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
