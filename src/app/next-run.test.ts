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

test('soonestNextRun picks the earliest estimate and ignores the rest', () => {
  const soon = new Date('2026-08-17T10:00:00Z');
  const later = new Date('2026-08-17T11:00:00Z');
  const at = soonestNextRun([
    { cron: '0 * * * *', lastScheduling: later }, // -> 12:00
    { cron: '0 * * * *', lastScheduling: soon }, // -> 11:00
    { cron: '0 6 * * *', lastScheduling: soon }, // -> null, ignored
  ]);
  assert.deepEqual(at, new Date('2026-08-17T11:00:00Z'));
});

test('soonestNextRun is null when nothing can be estimated', () => {
  assert.equal(soonestNextRun([]), null);
  assert.equal(soonestNextRun([{ cron: null, lastScheduling: null }]), null);
});

test('describeCountdown says overdue once the estimate has passed', () => {
  assert.equal(describeCountdown(0), 'overdue');
  assert.equal(describeCountdown(-300), 'overdue');
});

test('describeCountdown names the wait in words', () => {
  assert.equal(describeCountdown(30), 'in less than a minute');
  assert.equal(describeCountdown(60), 'in 1 minute');
  assert.equal(describeCountdown(120), 'in 2 minutes');
  assert.equal(describeCountdown(2040), 'in 34 minutes');
  assert.equal(describeCountdown(3600), 'in about 1 hour');
  assert.equal(describeCountdown(7200), 'in about 2 hours');
});
