/**
 * The seam that makes F-02 real.
 *
 * One interface, three intended implementations, one of them written in v1.0.
 * Everything upstream of this file speaks the internal model from
 * `src/core/model.ts`; everything downstream may speak its own source's
 * vocabulary and must not let it out.
 */
import type { RenovateRun, Repo, SourceAdapterId, Update } from '../core/model.ts';

/** Which kind of source an adapter reads. */
export type SourceKind = 'ce' | 'jsonlog' | 'forge';

/**
 * Something the operator must fix, named precisely enough to act on.
 *
 * Metric M-5 requires that at least 90% of empty dashboards name the exact
 * missing setting, which is why `setting` exists and why `detail` is never the
 * only field carrying the answer.
 */
/** One setting to change, on one of the two containers. */
export interface PreflightRemedy {
  variable: string;
  value: string;
  /** The Renovate server and its worker are separate containers. */
  target: 'server' | 'worker';
}

export interface PreflightProblem {
  /** What was probed, in the source's terms. */
  probe: string;
  /**
   * The configuration setting whose absence explains the failure, when one
   * does. Null when the cause is a wrong credential or an unreachable host.
   */
  setting: string | null;
  detail: string;
  /** Whether Withe can still show something useful without this. */
  fatal: boolean;
  /**
   * Machine-readable form of the fix, so the page can render a Compose block
   * rather than asking the operator to translate prose into settings. Empty
   * when no setting would help — a wrong token, for instance.
   */
  remedies: PreflightRemedy[];
}

export interface PreflightResult {
  /** True when every probe that Withe needs to function passed. */
  ok: boolean;
  problems: PreflightProblem[];
  /**
   * Set when every probe passed and the source reports no repositories. The UI
   * says so rather than showing a generic empty state — PRD open question Q-6.
   */
  reachableButEmpty: boolean;
  /**
   * A Compose fragment fixing everything found, or an empty string. Built here
   * rather than in the page, because the page should not have to know which
   * container each setting belongs to.
   */
  compose: string;
}

/**
 * What one collection pass produced.
 *
 * `warnings` is the degradation channel. An adapter that loses one API family
 * returns partial data and a warning; it does not throw. A silent empty page is
 * the failure mode this field exists to prevent.
 */
/** What a source knows about the forge it works against. */
export interface SourceMeta {
  platform: string | null;
  /** Browsable base URL, not the API endpoint. Null when it cannot be derived. */
  webBaseUrl: string | null;
  /** The runner's cron, as reported. Null when the server does not report one. */
  scheduleCron: string | null;
  /** When that cron last scheduled. Null when the server does not report it. */
  scheduleLastAt: Date | null;
}

export interface CollectResult {
  repos: Repo[];
  runs: RenovateRun[];
  updates: Update[];
  warnings: string[];
  /**
   * Absent when the source cannot say. The pages then render names as plain
   * text rather than guessing at github.com, which is the wrong answer for the
   * self-hosted forges Withe exists to support.
   */
  meta?: SourceMeta;
}

/**
 * Reads one configured source.
 *
 * No method writes to the database. An adapter returns the internal model and
 * the worker persists it, so that persistence has one owner and an adapter can
 * be tested with no database at all.
 */
export interface SourceAdapter {
  /** Stable, from configuration. Stored on every record this adapter produces. */
  readonly id: SourceAdapterId;
  readonly kind: SourceKind;

  /** What is reachable and what is missing. F-01. */
  preflight(): Promise<PreflightResult>;

  /** Repositories, runs and updates in the internal model. */
  collect(): Promise<CollectResult>;

  /**
   * The run's log, streamed. Logs are megabytes and are never stored, so this
   * returns a stream rather than a string. F-06. The parameter names only the
   * fields a log fetch reads, so a caller holding a bare run reference does
   * not have to fabricate a full run.
   */
  fetchLog(run: Pick<RenovateRun, 'repoId' | 'externalJobId'>): Promise<ReadableStream<Uint8Array>>;
}

/** Everything an adapter needs to be built, before it knows its own kind. */
export interface SourceConfig {
  id: SourceAdapterId;
  kind: SourceKind;
  /** Base URL of the source, for the kinds that have one. */
  url?: string;
  /** Credential for the source, for the kinds that need one. */
  token?: string;
  /** Directory to watch, for the kinds that read files. */
  path?: string;
  /**
   * TEMPORARY(org-discovery). Organization names supplied by hand instead of
   * discovered.
   *
   * This exists because `GET /api/v1/orgs` is the only way to learn what to
   * enumerate, and it behaves badly for a fleet that lives under a personal
   * account rather than a real organization. Asking the operator to type the
   * name is a workaround, not a design: it can go stale, it can be wrong, and
   * it pushes a question Withe should answer onto the person installing it.
   *
   * The underlying question is open and unresearched — see `tad.md` Section
   * 7.7.2. Remove this field when it is answered. Do not build anything new on
   * top of it.
   */
  orgs?: string[];
}

export type SourceAdapterFactory = (config: SourceConfig) => SourceAdapter;
