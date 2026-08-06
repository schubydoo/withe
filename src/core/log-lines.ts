/**
 * Turning an NDJSON log into rows a viewer can show.
 *
 * Kept out of the component so the parsing, the level mapping and the filtering
 * can be tested without a browser. The component's own job is scrolling.
 */

/** Bunyan numeric levels, which is what Renovate writes. */
export const LEVELS = {
  10: 'trace',
  20: 'debug',
  30: 'info',
  40: 'warn',
  50: 'error',
  60: 'fatal',
} as const;

export type LevelName = (typeof LEVELS)[keyof typeof LEVELS] | 'raw';

export interface LogLine {
  /** Position in the file, so a filtered view can still say where a line was. */
  index: number;
  level: LevelName;
  time: string | null;
  message: string;
  /** The whole entry, for the detail expander. Null for a line that would not parse. */
  entry: Record<string, unknown> | null;
  /** The original text, kept for raw lines and for search. */
  raw: string;
}

export interface ParsedLog {
  lines: LogLine[];
  /** Lines that were not valid JSON. Counted rather than dropped. */
  malformed: number;
  /** Index of the first warn-or-worse line, or -1. */
  firstProblem: number;
}

function levelOf(value: unknown): LevelName {
  if (typeof value === 'number' && value in LEVELS) return LEVELS[value as keyof typeof LEVELS];
  if (typeof value === 'string') {
    const named = Object.values(LEVELS).find((name) => name === value.toLowerCase());
    if (named) return named;
  }
  return 'info';
}

const PROBLEM: readonly LevelName[] = ['warn', 'error', 'fatal'];

export function isProblem(level: LevelName): boolean {
  return PROBLEM.includes(level);
}

/**
 * Parse whole lines of NDJSON.
 *
 * A line that is not JSON becomes a `raw` row rather than an exception. Renovate
 * logs are written by a process that can also print to the same stream, and one
 * stray line must not cost the operator the whole view (F-06).
 */
export function parseLines(text: string, startIndex = 0): ParsedLog {
  const lines: LogLine[] = [];
  let malformed = 0;
  let firstProblem = -1;

  const chunks = text.split('\n');
  for (const [offset, raw] of chunks.entries()) {
    if (raw.trim() === '') continue;
    const index = startIndex + offset;

    let entry: Record<string, unknown> | null = null;
    try {
      const value: unknown = JSON.parse(raw);
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        entry = value as Record<string, unknown>;
      }
    } catch {
      entry = null;
    }

    if (!entry) {
      malformed += 1;
      lines.push({ index, level: 'raw', time: null, message: raw, entry: null, raw });
      continue;
    }

    const level = levelOf(entry.level);
    if (firstProblem === -1 && isProblem(level)) firstProblem = lines.length;
    lines.push({
      index,
      level,
      time: typeof entry.time === 'string' ? entry.time : null,
      message: typeof entry.msg === 'string' ? entry.msg : raw,
      entry,
      raw,
    });
  }

  return { lines, malformed, firstProblem };
}

export interface Filter {
  /** Levels to show. Empty means show everything. */
  levels: readonly LevelName[];
  /** Case-insensitive substring over the whole original line. */
  search: string;
}

/**
 * Apply a filter over already-received lines.
 *
 * Search runs over the raw text rather than the message, so a field value the
 * viewer does not render is still findable — which is most of what a Renovate
 * log carries.
 */
export function applyFilter(lines: readonly LogLine[], filter: Filter): LogLine[] {
  const needle = filter.search.trim().toLowerCase();
  const levels = filter.levels;

  if (levels.length === 0 && needle === '') return [...lines];

  return lines.filter((line) => {
    if (levels.length > 0 && !levels.includes(line.level)) return false;
    if (needle !== '' && !line.raw.toLowerCase().includes(needle)) return false;
    return true;
  });
}
