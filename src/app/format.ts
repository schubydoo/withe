/**
 * Display conventions shared by more than one page.
 *
 * Each function here is the one definition of how the pages render a kind of
 * value. Two copies of a format become two formats the first time one is
 * edited.
 */
import type { RunRow } from '../db/queries.ts';

/**
 * A past instant as a distance: "just now", "5m ago", "3h ago", "2d ago".
 * `ifNever` is the word for an instant that never happened. The pages disagree
 * on that word ("never" on /health, "—" on /repos), so the choice stays at the
 * call site.
 */
export function ago(when: Date | null, ifNever: string): string {
  if (!when) return ifNever;
  const minutes = Math.round((Date.now() - when.getTime()) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/**
 * The instant that names a run — completion, else start, else queueing — as
 * UTC "YYYY-MM-DD HH:MM:SS". Null when the run has none of the three; the
 * caller chooses the words for that.
 */
export function runWhen(run: Pick<RunRow, 'completedAt' | 'startedAt' | 'queuedAt'>): string | null {
  return (run.completedAt ?? run.startedAt ?? run.queuedAt)?.toISOString().replace('T', ' ').slice(0, 19) ?? null;
}
