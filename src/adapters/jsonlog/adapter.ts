/**
 * Reads a directory of Renovate JSON Lines logs (Task 4.2, PRD Q-4).
 *
 * This is the adapter for the operator who runs plain `renovate/renovate` —
 * a cron container, a CI job, or by hand — and has no server API to ask. The
 * operator mounts the log directory read-only and changes nothing about how
 * Renovate runs; that is the product's central claim, which is why there is
 * no stream tailing and no `fs.watch`: the sync cycle re-scans the directory,
 * which is what "picked up without a restart" needs and avoids `fs.watch`'s
 * platform unreliability entirely.
 *
 * Every filesystem access is a read. Withe never writes to, moves, or deletes
 * a log file (NFR-11 in spirit; the files are the operator's source record).
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import type { RenovateRun, Repo, RepoInstallStatus, Update } from '../../core/model.ts';
import { extractFromLog } from '../../core/renovate-log.ts';
import { registerAdapter } from '../registry.ts';
import type {
  CollectResult,
  PreflightProblem,
  PreflightResult,
  SourceAdapter,
  SourceConfig,
} from '../types.ts';
import { parseLogFile, type ParsedRun } from './parse.ts';

/** What counts as a log file. Renovate writes `.log`; CI wrappers and
 * hand-copies commonly use the JSON Lines extensions. */
const LOG_EXTENSIONS = ['.log', '.jsonl', '.ndjson'];

/** Subdirectories are walked this deep — a CI artifact unzips into one. */
const MAX_DEPTH = 3;

/** A file larger than this is not a run log; reading it would stall the sync. */
const MAX_FILE_BYTES = 100 * 1024 * 1024;

interface FoundRun {
  run: ParsedRun;
  /** Path relative to the configured directory, for messages and addressing. */
  file: string;
}

export class JsonLogAdapter implements SourceAdapter {
  readonly id: string;
  readonly kind = 'jsonlog' as const;

  private readonly directory: string;

  constructor(config: SourceConfig) {
    if (!config.path) throw new Error(`Source '${config.id}' needs a path`);
    this.id = config.id;
    this.directory = config.path;
  }

  async preflight(): Promise<PreflightResult> {
    const problems: PreflightProblem[] = [];

    const readable = this.probeDirectory(problems);
    if (!readable) {
      return { ok: false, problems, reachableButEmpty: false, compose: '' };
    }

    const { files, warnings } = this.listFiles();
    for (const warning of warnings) {
      problems.push({ probe: 'log files', setting: null, detail: warning, fatal: false, remedies: [] });
    }
    if (files.length === 0) {
      problems.push({
        probe: 'log files',
        setting: null,
        detail:
          `${this.directory} contains no log file (looked for ${LOG_EXTENSIONS.join(', ')}). ` +
          `Point Renovate's RENOVATE_LOG_FILE into this directory, or copy run logs into it.`,
        fatal: false,
        remedies: [],
      });
    }

    return {
      ok: true,
      problems,
      reachableButEmpty: files.length === 0,
      compose: '',
    };
  }

  async collect(): Promise<CollectResult> {
    const warnings: string[] = [];
    const { files, warnings: listWarnings } = this.listFiles();
    warnings.push(...listWarnings);

    const found = this.readRuns(files, warnings);

    // The same run appears twice when the operator copies a file they also
    // mount live. One external id per run keeps one row per run.
    const byJob = new Map<string, FoundRun>();
    for (const item of found) {
      const key = externalJobId(item.run, item.file);
      if (!byJob.has(key)) byJob.set(key, item);
    }

    const repos = this.buildRepos([...byJob.values()]);
    const runs: RenovateRun[] = [];
    for (const [jobId, { run, file }] of byJob) {
      runs.push(this.buildRun(jobId, run, file));
    }

    const updates = await this.buildUpdates([...byJob.values()], warnings);

    return { repos, runs, updates, warnings };
  }

  async fetchLog(run: Pick<RenovateRun, 'repoId' | 'externalJobId'>): Promise<ReadableStream<Uint8Array>> {
    // Logs live in the operator's files, so the slice is found by re-scanning
    // rather than kept in memory between syncs. A fetch happens on a click.
    const { files } = this.listFiles();
    const silent: string[] = [];
    for (const item of this.readRuns(files, silent)) {
      if (externalJobId(item.run, item.file) === run.externalJobId) {
        const text = item.run.lines.join('\n') + '\n';
        const bytes = new TextEncoder().encode(text);
        return new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(bytes);
            controller.close();
          },
        });
      }
    }
    throw new Error(`The log for run ${run.externalJobId} is no longer in ${this.directory}.`);
  }

  /** True when the directory exists and can be listed. */
  private probeDirectory(problems: PreflightProblem[]): boolean {
    try {
      if (!statSync(this.directory).isDirectory()) {
        problems.push({
          probe: 'log directory',
          setting: 'sources[].path',
          detail: `${this.directory} exists but is not a directory.`,
          fatal: true,
          remedies: [],
        });
        return false;
      }
      readdirSync(this.directory);
      return true;
    } catch (cause) {
      problems.push({
        probe: 'log directory',
        setting: 'sources[].path',
        detail:
          `Cannot read ${this.directory}: ${describe(cause)}. ` +
          `Mount the runner's log directory read-only at this path.`,
        fatal: true,
        remedies: [],
      });
      return false;
    }
  }

  /** Log files under the directory, walked to a shallow depth. */
  private listFiles(): { files: string[]; warnings: string[] } {
    const files: string[] = [];
    const warnings: string[] = [];
    const walk = (dir: string, depth: number): void => {
      let names: string[];
      try {
        names = readdirSync(dir);
      } catch (cause) {
        warnings.push(`Could not list ${dir}: ${describe(cause)}`);
        return;
      }
      for (const name of names) {
        if (name.startsWith('.')) continue;
        const path = join(dir, name);
        let stat;
        try {
          stat = statSync(path);
        } catch {
          continue; // Vanished between listing and stat — a rotation, not an error.
        }
        if (stat.isDirectory()) {
          if (depth < MAX_DEPTH) walk(path, depth + 1);
          continue;
        }
        if (!LOG_EXTENSIONS.some((ext) => name.toLowerCase().endsWith(ext))) continue;
        if (stat.size > MAX_FILE_BYTES) {
          warnings.push(
            `${relative(this.directory, path)} is ${Math.round(stat.size / (1024 * 1024))} MB — ` +
              `too large for a run log; skipped.`,
          );
          continue;
        }
        files.push(path);
      }
    };
    walk(this.directory, 0);
    return { files: files.sort(), warnings };
  }

  private readRuns(files: string[], warnings: string[]): FoundRun[] {
    const found: FoundRun[] = [];
    for (const path of files) {
      const file = relative(this.directory, path);
      let text: string;
      try {
        text = readFileSync(path, 'utf8');
      } catch (cause) {
        warnings.push(`Could not read ${file}: ${describe(cause)}`);
        continue;
      }
      const parsed = parseLogFile(text);
      if (parsed.runs.length === 0) {
        // A malformed file is skipped with a warning, never a crash. A file
        // with no runs and no JSON is not a Renovate log at all.
        if (parsed.totalLines > 0) {
          warnings.push(
            parsed.malformedLines === parsed.totalLines
              ? `${file} is not JSON Lines; skipped.`
              : `${file} contains no recognizable Renovate run; skipped.`,
          );
        }
        continue;
      }
      for (const run of parsed.runs) found.push({ run, file });
    }
    return found;
  }

  private buildRepos(found: FoundRun[]): Repo[] {
    // The newest run's word wins for the install state, as it does upstream.
    const newest = new Map<string, FoundRun>();
    for (const item of found) {
      const existing = newest.get(item.run.repository);
      if (!existing || after(item.run, existing.run)) newest.set(item.run.repository, item);
    }

    return [...newest.values()].map(({ run }) => {
      const [org = '', name = ''] = run.repository.split('/');
      return {
        id: `${this.id}:${run.repository}`,
        org,
        name,
        fullName: run.repository,
        // A log names only repositories the runner processed, so every one of
        // them is enabled as far as this source can know.
        enabled: true,
        installStatus: mapInstallStatus(run.installStatus),
        queueName: null,
        installedAt: null,
        removedAt: null,
        sourceAdapterId: this.id,
      };
    });
  }

  private buildRun(jobId: string, run: ParsedRun, file: string): RenovateRun {
    return {
      id: `${this.id}:${jobId}`,
      repoId: `${this.id}:${run.repository}`,
      externalJobId: jobId,
      // A log line states no trigger; inventing one would be a guess.
      triggerReason: null,
      queuedAt: null,
      startedAt: run.startedAt,
      completedAt: run.completedAt,
      status: run.status,
      error: run.error,
      artifactErrors: [],
      logLocation: `${file}#L${run.firstLine}-L${run.lastLine}`,
      runnerVersion: run.runnerVersion,
      sourceAdapterId: this.id,
    };
  }

  private async buildUpdates(found: FoundRun[], warnings: string[]): Promise<Update[]> {
    // Pending updates come from each repository's newest run only — an older
    // run describes a state that has been superseded, same rule as upstream.
    const newest = new Map<string, FoundRun>();
    for (const item of found) {
      const existing = newest.get(item.run.repository);
      if (!existing || after(item.run, existing.run)) newest.set(item.run.repository, item);
    }

    const updates: Update[] = [];
    for (const { run, file } of newest.values()) {
      try {
        const extract = await extractFromLog(lineStream(run.lines), {
          repoId: `${this.id}:${run.repository}`,
          sourceAdapterId: this.id,
          detectedAt: run.completedAt ?? run.startedAt ?? new Date(),
        });
        updates.push(...extract.updates);
      } catch (cause) {
        warnings.push(`Could not read updates for ${run.repository} from ${file}: ${describe(cause)}`);
      }
    }
    return updates;
  }
}

/**
 * A stable identity for one run.
 *
 * The start instant plus the repository survives re-scans and dedupes a file
 * the operator copied next to the one the runner still writes. A run with no
 * timestamp at all falls back to its file address, which is stable for the
 * append-only files runners write.
 */
function externalJobId(run: ParsedRun, file: string): string {
  return run.startedAt
    ? `${run.repository}@${run.startedAt.toISOString()}`
    : `${run.repository}@${file}#L${run.firstLine}`;
}

/** Newest by completion, then by start, for picking the current state. */
function after(a: ParsedRun, b: ParsedRun): boolean {
  const at = (r: ParsedRun) => r.completedAt?.getTime() ?? r.startedAt?.getTime() ?? 0;
  return at(a) > at(b);
}

/** The runner's words for an install state, mapped like the server adapter maps
 * its own. An unrecognized word degrades to `unknown`, never to a crash. */
function mapInstallStatus(status: string | null): RepoInstallStatus {
  switch (status) {
    case 'activated':
    case 'onboarded':
    case 'onboarding':
    case 'disabled':
    case 'removed':
      return status;
    default:
      return 'unknown';
  }
}

async function* lineStream(lines: readonly string[]): AsyncIterable<string> {
  for (const line of lines) yield line + '\n';
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

registerAdapter('jsonlog', (config) => new JsonLogAdapter(config));
