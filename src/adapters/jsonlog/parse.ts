/**
 * Group one log file's lines into runs (Task 4.2).
 *
 * The rule closed `tasks.md` AM-4 and was derived from real logs, not the
 * documentation, because log content carries no compatibility guarantee
 * (risk R-4). It is field-based, never message-text:
 *
 * - A line carrying `renovateVersion` with **no** `repository` opens an
 *   **invocation** — the header every runner shape writes once per start.
 * - Within an invocation, a **run** is one repository's contiguous slice of
 *   lines, because the runner processes repositories sequentially. The slice
 *   spans from the repository's first line to its last, so the unlabeled
 *   lines between them (git output, lookups) stay with the run they belong to.
 * - A `repository` value must look like `org/name`. The runner also stamps
 *   lookup URLs into that field mid-run; a URL is not a repository.
 *
 * One file may hold many invocations (an operator appending to one file),
 * one invocation many runs (a multi-repo cron), or exactly one of each (a CI
 * artifact). All three shapes reduce to the same rule.
 */

/** `org/name` and nothing else — one slash, no scheme, no spaces. */
const REPO_SHAPE = /^[^\s/:]+\/[^\s/:]+$/;

/** Bunyan's error level. At or above this, the run failed. */
const LEVEL_FATAL = 60;

export interface ParsedRun {
  /** `org/name`, as the log states it. */
  repository: string;
  startedAt: Date | null;
  completedAt: Date | null;
  /** Failed when the slice carries a fatal line; success otherwise. A log
   * only ever describes finished work, so nothing here is queued or running. */
  status: 'success' | 'failed';
  /** The first fatal line's message, when the run failed. */
  error: string | null;
  /** From the invocation header, or from the slice itself. */
  runnerVersion: string | null;
  /** What the runner said the repository's install state was, in its words. */
  installStatus: string | null;
  /** The slice, as raw lines, for streaming a run's log back out. */
  lines: string[];
  /** 1-based line numbers in the file, for addressing the slice. */
  firstLine: number;
  lastLine: number;
}

export interface ParsedFile {
  runs: ParsedRun[];
  /** Lines that were not JSON. A few are tolerable (a truncated tail); a file
   * with no JSON at all is not a log and the caller warns once. */
  malformedLines: number;
  totalLines: number;
}

interface Entry {
  raw: string;
  lineNo: number;
  repository: string | null;
  time: Date | null;
  level: number | null;
  msg: string | null;
  renovateVersion: string | null;
  installStatus: string | null;
}

function readEntry(raw: string, lineNo: number): Entry | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const o = parsed as Record<string, unknown>;

  const repoRaw = typeof o.repository === 'string' ? o.repository : null;
  const time = typeof o.time === 'string' ? new Date(o.time) : null;
  // The finish line carries `durationMs` with a string `status` — the install
  // state. Field shapes, not message text (core/renovate-log.ts states why).
  const installStatus =
    typeof o.durationMs === 'number' && typeof o.status === 'string' ? o.status : null;

  return {
    raw,
    lineNo,
    repository: repoRaw && REPO_SHAPE.test(repoRaw) ? repoRaw : null,
    time: time && !Number.isNaN(time.getTime()) ? time : null,
    level: typeof o.level === 'number' ? o.level : null,
    msg: typeof o.msg === 'string' ? o.msg : null,
    renovateVersion: typeof o.renovateVersion === 'string' ? o.renovateVersion : null,
    installStatus,
  };
}

/** Split a file into invocations, then each invocation into per-repo slices. */
export function parseLogFile(text: string): ParsedFile {
  const rawLines = text.split('\n');
  if (rawLines.at(-1) === '') rawLines.pop();

  const entries: Entry[] = [];
  let malformedLines = 0;
  for (const [index, raw] of rawLines.entries()) {
    if (raw.trim() === '') continue;
    const entry = readEntry(raw, index + 1);
    if (entry) entries.push(entry);
    else malformedLines += 1;
  }

  // Invocation boundaries: a version stamp with no repository is the header.
  const starts: number[] = [];
  for (const [index, entry] of entries.entries()) {
    if (entry.renovateVersion && !entry.repository) starts.push(index);
  }
  // A file that starts mid-stream (a truncated copy) still forms one
  // invocation from its first line.
  if (starts[0] !== 0) starts.unshift(0);

  const runs: ParsedRun[] = [];
  for (const [which, from] of starts.entries()) {
    const to = starts[which + 1] ?? entries.length;
    runs.push(...sliceInvocation(entries.slice(from, to)));
  }

  return { runs, malformedLines, totalLines: rawLines.length };
}

function sliceInvocation(entries: Entry[]): ParsedRun[] {
  const headerVersion = entries.find((e) => e.renovateVersion)?.renovateVersion ?? null;

  // First and last index per repository. Contiguity holds because the runner
  // is sequential; taking min/max rather than tracking open/close also
  // tolerates a log whose start or finish line was lost.
  const bounds = new Map<string, { first: number; last: number }>();
  for (const [index, entry] of entries.entries()) {
    if (!entry.repository) continue;
    const bound = bounds.get(entry.repository);
    if (!bound) bounds.set(entry.repository, { first: index, last: index });
    else bound.last = index;
  }

  const runs: ParsedRun[] = [];
  for (const [repository, bound] of bounds) {
    const slice = entries.slice(bound.first, bound.last + 1);
    const timed = slice.filter((e) => e.time);
    const fatal = slice.find((e) => (e.level ?? 0) >= LEVEL_FATAL);
    runs.push({
      repository,
      startedAt: timed[0]?.time ?? null,
      completedAt: timed.at(-1)?.time ?? null,
      status: fatal ? 'failed' : 'success',
      error: fatal ? (fatal.msg ?? 'fatal error with no message') : null,
      runnerVersion: slice.find((e) => e.renovateVersion)?.renovateVersion ?? headerVersion,
      installStatus: slice.find((e) => e.repository === repository && e.installStatus)?.installStatus ?? null,
      lines: slice.map((e) => e.raw),
      firstLine: slice[0]?.lineNo ?? 0,
      lastLine: slice.at(-1)?.lineNo ?? 0,
    });
  }
  return runs;
}
