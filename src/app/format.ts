/**
 * Display conventions shared by more than one page.
 *
 * Each function here is the one definition of how the pages render a kind of
 * value. Two copies of a format become two formats the first time one is
 * edited.
 */
import type { RunRow } from '../db/queries.ts';

/** A duration's coarsest sensible unit and its rounded count. */
export interface Magnitude {
  value: number;
  unit: 'minute' | 'hour' | 'day';
}

/**
 * The minutes → hours → days ladder three call sites share: minutes up to an
 * hour, hours up to two days, days beyond, each rounded off the one below.
 *
 * Only the ladder is shared. What to say under a minute ("just now", "less than
 * a minute old", "in less than a minute") and how to render a unit (`3h ago`
 * versus `3 hours old` versus `in about 3 hours`) differ per caller and stay at
 * the call site — this is reached once the caller has a minute or more to name.
 */
export function magnitude(seconds: number): Magnitude {
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return { value: minutes, unit: 'minute' };
  const hours = Math.round(minutes / 60);
  if (hours < 48) return { value: hours, unit: 'hour' };
  return { value: Math.round(hours / 24), unit: 'day' };
}

const SHORT: Record<Magnitude['unit'], string> = { minute: 'm', hour: 'h', day: 'd' };

/**
 * A past instant as a distance: "just now", "5m ago", "3h ago", "2d ago".
 * `ifNever` is the word for an instant that never happened. The pages disagree
 * on that word ("never" on /health, "—" on /repos), so the choice stays at the
 * call site.
 */
export function ago(when: Date | null, ifNever: string): string {
  if (!when) return ifNever;
  const seconds = (Date.now() - when.getTime()) / 1000;
  if (Math.round(seconds / 60) < 1) return 'just now';
  const { value, unit } = magnitude(seconds);
  return `${value}${SHORT[unit]} ago`;
}

/**
 * The instant that names a run — completion, else start, else queueing — as
 * UTC "YYYY-MM-DD HH:MM:SS". Null when the run has none of the three; the
 * caller chooses the words for that.
 */
export function runWhen(run: Pick<RunRow, 'completedAt' | 'startedAt' | 'queuedAt'>): string | null {
  return (run.completedAt ?? run.startedAt ?? run.queuedAt)?.toISOString().replace('T', ' ').slice(0, 19) ?? null;
}
