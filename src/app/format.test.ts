import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ago, magnitude, runWhen } from './format.ts';

const MINUTE = 60_000;

test('magnitude climbs the ladder minutes -> hours -> days, on the rounded edge', () => {
  assert.deepEqual(magnitude(5 * 60), { value: 5, unit: 'minute' });
  // The rung flips when the *rounded* count reaches the next unit's bound, so
  // the minute->hour edge is 59.5 minutes and the hour->day edge is 47.5 hours,
  // not a clean 60 or 48.
  assert.deepEqual(magnitude(59 * 60 + 29), { value: 59, unit: 'minute' }); // 59.48m rounds to 59
  assert.deepEqual(magnitude(59 * 60 + 30), { value: 1, unit: 'hour' }); // 59.5m rounds to 60 -> 1h
  assert.deepEqual(magnitude(47 * 3600), { value: 47, unit: 'hour' });
  assert.deepEqual(magnitude(171_000), { value: 2, unit: 'day' }); // 47.5h rounds to 48h -> 2 days
  assert.deepEqual(magnitude(10 * 86_400), { value: 10, unit: 'day' });
});

test('magnitude rounds each rung off the one below', () => {
  assert.deepEqual(magnitude(90), { value: 2, unit: 'minute' }); // 1.5 min rounds up
  assert.deepEqual(magnitude(89), { value: 1, unit: 'minute' });
});

test('ago names each bucket of distance', () => {
  const now = Date.now();
  assert.equal(ago(new Date(now), '—'), 'just now');
  assert.equal(ago(new Date(now - 5 * MINUTE), '—'), '5m ago');
  assert.equal(ago(new Date(now - 3 * 60 * MINUTE), '—'), '3h ago');
  assert.equal(ago(new Date(now - 47 * 60 * MINUTE), '—'), '47h ago');
  assert.equal(ago(new Date(now - 49 * 60 * MINUTE), '—'), '2d ago');
  assert.equal(ago(new Date(now - 10 * 24 * 60 * MINUTE), '—'), '10d ago');
});

test("a null instant gets the caller's word, because the pages disagree on it", () => {
  assert.equal(ago(null, 'never'), 'never');
  assert.equal(ago(null, '—'), '—');
});

test('runWhen prefers completion, then start, then queueing', () => {
  const completed = new Date('2026-08-06T17:05:09.500Z');
  const started = new Date('2026-08-06T17:00:00.000Z');
  const queued = new Date('2026-08-06T16:55:00.000Z');

  assert.equal(runWhen({ completedAt: completed, startedAt: started, queuedAt: queued }), '2026-08-06 17:05:09');
  assert.equal(runWhen({ completedAt: null, startedAt: started, queuedAt: queued }), '2026-08-06 17:00:00');
  assert.equal(runWhen({ completedAt: null, startedAt: null, queuedAt: queued }), '2026-08-06 16:55:00');
});

test('a run with no instant at all yields null; the caller chooses the words', () => {
  assert.equal(runWhen({ completedAt: null, startedAt: null, queuedAt: null }), null);
});
