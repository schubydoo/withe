/**
 * When Renovate runs next, estimated from the runner's own schedule (B-5).
 *
 * The status endpoint reports a cron and the last instant it scheduled, but no
 * timezone. Rather than place cron fields on a clock we cannot read, this
 * projects forward from the absolute last-scheduling instant by the cron's
 * period: `next = lastScheduling + period`. A duration added to an instant is
 * free of any timezone, the runner's and the browser's alike.
 *
 * That only works for crons that fire on a fixed interval. A cron that pins an
 * hour, day, or weekday does need the runner's timezone to place, so this
 * returns null for those and the caller shows nothing rather than a wrong guess.
 */
import { magnitude, plural } from './format.ts';

export interface Schedule {
  cron: string | null;
  lastScheduling: Date | null;
}

/**
 * The period of an interval cron in seconds, or null when the cron is not a
 * plain interval. Handles the shapes Renovate CE uses: every minute, every N
 * minutes (a stepped minute field), and once an hour at a fixed minute. Any
 * constraint on the hour, day, month, or weekday makes the next fire depend on
 * the runner's timezone, so those return null.
 */
export function cronPeriodSeconds(cron: string): number | null {
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5) return null;
  const [minute, hour, dayOfMonth, month, dayOfWeek] = fields;
  if (minute === undefined) return null;

  // Only an unconstrained hour/day/month/weekday is timezone-free.
  if (hour !== '*' || dayOfMonth !== '*' || month !== '*' || dayOfWeek !== '*') return null;

  if (minute === '*') return 60;

  const stepValue = /^\*\/(\d{1,2})$/.exec(minute)?.[1];
  if (stepValue !== undefined) {
    const n = Number(stepValue);
    // A stepped minute restarts at 0 each hour, so `*/N` is an even interval only
    // when N divides 60. `*/7` fires at :56 then :00 — a 4-minute gap, not 7 — so
    // `last + 7 min` would mis-estimate near the hour. Reject the non-divisors.
    return n >= 1 && n <= 59 && 60 % n === 0 ? n * 60 : null;
  }

  // A single minute-of-hour fires once an hour, whatever the timezone's offset.
  if (/^\d{1,2}$/.test(minute)) {
    const m = Number(minute);
    return m >= 0 && m <= 59 ? 3600 : null;
  }

  // Lists and ranges (`0,30`, `0-15`) are not one interval; do not guess.
  return null;
}

/**
 * The instant the next run is due, or null when it cannot be estimated without
 * guessing — no cron, no last-scheduling instant, or a cron that is not a plain
 * interval. The result may be in the past; the caller says "overdue" then rather
 * than rolling it forward, so a stuck scheduler is not hidden.
 */
export function nextRunAt(schedule: Schedule): Date | null {
  if (!schedule.cron || !schedule.lastScheduling) return null;
  const period = cronPeriodSeconds(schedule.cron);
  if (period === null) return null;
  return new Date(schedule.lastScheduling.getTime() + period * 1000);
}

/**
 * The soonest next run across sources, or null when none can be estimated.
 *
 * An estimate already more than `graceMs` in the past is ignored rather than
 * chosen. `lastScheduling` lags a sync by up to one interval, and a source
 * dropped from the config keeps its last schedule forever (nothing prunes the
 * `source` table), so without this one ancient estimate would win the minimum
 * and pin the header past-due while the live sources are fine. `nowMs` is passed
 * so this stays pure and testable.
 */
export function soonestNextRun(schedules: readonly Schedule[], nowMs: number, graceMs: number): Date | null {
  let soonest: Date | null = null;
  for (const schedule of schedules) {
    const at = nextRunAt(schedule);
    if (!at || at.getTime() < nowMs - graceMs) continue;
    if (soonest === null || at.getTime() < soonest.getTime()) soonest = at;
  }
  return soonest;
}

/**
 * The countdown in words, or null to show nothing. `graceSeconds` bounds how far
 * past the estimate the run still reads as "due now": `lastScheduling` lags a
 * sync by up to that, so a moment past the estimate is that lag, not a stuck run.
 * Beyond the grace the estimate is too stale to trust — the page has not
 * re-fetched it — so this returns null rather than an indefinite "overdue"; the
 * staleness banner (B-9) is the authority on a genuinely stuck scheduler.
 */
export function describeCountdown(remainingSeconds: number, graceSeconds: number): string | null {
  if (remainingSeconds < -graceSeconds) return null;
  if (remainingSeconds <= 0) return 'due now';
  if (remainingSeconds < 60) return 'in less than a minute';
  const { value, unit } = magnitude(remainingSeconds);
  // Minutes are exact; an hour or a day is a rounded estimate, so it is hedged.
  const prefix = unit === 'minute' ? 'in' : 'in about';
  return `${prefix} ${plural(value, unit)}`;
}
