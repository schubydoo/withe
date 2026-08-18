import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  cronPeriodSeconds,
  describeCountdown,
  nextRunAt,
  soonestNextRun,
} from './next-run.ts';

test('cronPeriodSeconds reads interval crons Renovate uses', () => {
  assert.equal(cronPeriodSeconds('0 * * * *'), 3600, 'hourly at minute 0');
  assert.equal(cronPeriodSeconds('30 * * * *'), 3600, 'hourly at minute 30');
  assert.equal(cronPeriodSeconds('*/15 * * * *'), 900);
  assert.equal(cronPeriodSeconds('*/5 * * * *'), 300);
  assert.equal(cronPeriodSeconds('* * * * *'), 60);
});

test('cronPeriodSeconds refuses crons that need the runner timezone', () => {
  assert.equal(cronPeriodSeconds('0 6 * * *'), null, 'a fixed hour');
  assert.equal(cronPeriodSeconds('0 0 * * 1'), null, 'a weekday');
  assert.equal(cronPeriodSeconds('0 0 1 * *'), null, 'a day of month');
});

test('cronPeriodSeconds refuses shapes that are not one interval', () => {
  assert.equal(cronPeriodSeconds('0,30 * * * *'), null, 'a list');
  assert.equal(cronPeriodSeconds('0-15 * * * *'), null, 'a range');
  assert.equal(cronPeriodSeconds('*/0 * * * *'), null, 'a zero step');
  assert.equal(cronPeriodSeconds('*/60 * * * *'), null, 'an out-of-range step');
  assert.equal(cronPeriodSeconds('nonsense'), null);
  assert.equal(cronPeriodSeconds(''), null);
});

test('cronPeriodSeconds refuses a step that does not divide 60', () => {
  // `*/7` fires at :56 then :00, a 4-minute gap, so it is not one even interval.
  assert.equal(cronPeriodSeconds('*/7 * * * *'), null);
  assert.equal(cronPeriodSeconds('*/45 * * * *'), null);
  // The divisors Renovate uses stay exact.
  assert.equal(cronPeriodSeconds('*/10 * * * *'), 600);
  assert.equal(cronPeriodSeconds('*/30 * * * *'), 1800);
});

test('nextRunAt projects forward from the last scheduling instant', () => {
  const last = new Date('2026-08-17T10:00:00Z');
  assert.deepEqual(
    nextRunAt({ cron: '0 * * * *', lastScheduling: last }),
    new Date('2026-08-17T11:00:00Z'),
  );
  assert.deepEqual(
    nextRunAt({ cron: '*/15 * * * *', lastScheduling: last }),
    new Date('2026-08-17T10:15:00Z'),
  );
});

test('nextRunAt shows nothing when it would have to guess', () => {
  const last = new Date('2026-08-17T10:00:00Z');
  assert.equal(nextRunAt({ cron: null, lastScheduling: last }), null);
  assert.equal(nextRunAt({ cron: '0 * * * *', lastScheduling: null }), null);
  assert.equal(nextRunAt({ cron: '0 6 * * *', lastScheduling: last }), null);
});

const NOW = new Date('2026-08-17T10:00:00Z').getTime();
const GRACE_MS = 300_000;

test('soonestNextRun picks the earliest estimate and ignores the rest', () => {
  const soon = new Date('2026-08-17T10:00:00Z');
  const later = new Date('2026-08-17T11:00:00Z');
  const at = soonestNextRun(
    [
      { cron: '0 * * * *', lastScheduling: later }, // -> 12:00
      { cron: '0 * * * *', lastScheduling: soon }, // -> 11:00
      { cron: '0 6 * * *', lastScheduling: soon }, // -> null, ignored
    ],
    NOW,
    GRACE_MS,
  );
  assert.deepEqual(at, new Date('2026-08-17T11:00:00Z'));
});

test('soonestNextRun ignores an estimate more than the grace past due', () => {
  // A source dropped from the config keeps its last schedule forever, so its
  // estimate is ancient; it must not win the minimum over a live source.
  const at = soonestNextRun(
    [
      { cron: '0 * * * *', lastScheduling: new Date('2020-01-01T00:00:00Z') }, // ancient
      { cron: '0 * * * *', lastScheduling: new Date('2026-08-17T09:30:00Z') }, // -> 10:30, live
    ],
    NOW,
    GRACE_MS,
  );
  assert.deepEqual(at, new Date('2026-08-17T10:30:00Z'));
});

test('soonestNextRun keeps an estimate that is only just past due', () => {
  // Within the grace, a moment past the estimate is lastScheduling lag, not stale.
  const at = soonestNextRun(
    [{ cron: '* * * * *', lastScheduling: new Date(NOW - 120_000) }], // -> NOW - 60s
    NOW,
    GRACE_MS,
  );
  assert.deepEqual(at, new Date(NOW - 60_000));
});

test('soonestNextRun is null when nothing can be estimated', () => {
  assert.equal(soonestNextRun([], NOW, GRACE_MS), null);
  assert.equal(soonestNextRun([{ cron: null, lastScheduling: null }], NOW, GRACE_MS), null);
});

test('describeCountdown reads "due now" within the grace, then nothing', () => {
  assert.equal(describeCountdown(0, 300), 'due now');
  assert.equal(describeCountdown(-299, 300), 'due now', 'just past due is still due, not stale');
  assert.equal(describeCountdown(-301, 300), null, 'past the grace is too stale to trust');
});

test('describeCountdown names the wait in words', () => {
  assert.equal(describeCountdown(30, 300), 'in less than a minute');
  assert.equal(describeCountdown(60, 300), 'in 1 minute');
  assert.equal(describeCountdown(120, 300), 'in 2 minutes');
  assert.equal(describeCountdown(2040, 300), 'in 34 minutes');
  assert.equal(describeCountdown(3600, 300), 'in about 1 hour');
  assert.equal(describeCountdown(7200, 300), 'in about 2 hours');
});
