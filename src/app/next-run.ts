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
    return n >= 1 && n <= 59 ? n * 60 : null;
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

/** The soonest next run across sources, or null when none can be estimated. */
export function soonestNextRun(schedules: readonly Schedule[]): Date | null {
  let soonest: Date | null = null;
  for (const schedule of schedules) {
    const at = nextRunAt(schedule);
    if (at && (soonest === null || at.getTime() < soonest.getTime())) soonest = at;
  }
  return soonest;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/**
 * The countdown in words: "in 34 minutes", "in about 2 hours", or "overdue" once
 * the estimate has passed. The label names what it counts down to — a Renovate
 * run, not a pull request, which the preset's own schedule governs.
 */
export function describeCountdown(remainingSeconds: number): string {
  if (remainingSeconds <= 0) return 'overdue';
  if (remainingSeconds < 60) return 'in less than a minute';
  const minutes = Math.round(remainingSeconds / 60);
  if (minutes < 60) return `in ${plural(minutes, 'minute')}`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `in about ${plural(hours, 'hour')}`;
  return `in about ${plural(Math.round(hours / 24), 'day')}`;
}
