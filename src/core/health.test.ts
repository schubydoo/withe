import assert from 'node:assert/strict';
import { test } from 'node:test';

import { assess, statusCodeFor, STALE_AFTER_INTERVALS } from './health.ts';

const NOW = new Date('2026-08-14T12:00:00Z');
const INTERVAL = 300;

function agedBy(seconds: number): Date {
  return new Date(NOW.getTime() - seconds * 1000);
}

test('a source that synced within three intervals is healthy', () => {
  const health = assess([{ sourceAdapterId: 'default', lastSuccessAt: agedBy(60) }], INTERVAL, NOW);
  assert.equal(health.status, 'ok');
  assert.equal(health.ageSeconds, 60);
  assert.deepEqual(health.stale, []);
});

test('one late cycle does not fail the check', () => {
  // A container that goes red because a sync ran a second late is a container
  // whose colour nobody reads.
  const health = assess(
    [{ sourceAdapterId: 'default', lastSuccessAt: agedBy(INTERVAL * STALE_AFTER_INTERVALS - 1) }],
    INTERVAL,
    NOW,
  );
  assert.equal(health.status, 'ok');
});

test('past three intervals the source is stale and named', () => {
  const health = assess(
    [{ sourceAdapterId: 'home-ce', lastSuccessAt: agedBy(INTERVAL * STALE_AFTER_INTERVALS + 1) }],
    INTERVAL,
    NOW,
  );
  assert.equal(health.status, 'stale');
  assert.deepEqual(health.stale, ['home-ce']);
});

test('one healthy source does not cover for a dead one', () => {
  const health = assess(
    [
      { sourceAdapterId: 'fresh', lastSuccessAt: agedBy(30) },
      { sourceAdapterId: 'dead', lastSuccessAt: agedBy(86_400) },
    ],
    INTERVAL,
    NOW,
  );
  assert.equal(health.status, 'stale');
  assert.deepEqual(health.stale, ['dead']);
  // The age reported is the freshest one, which is what "how current is this
  // dashboard at best" means.
  assert.equal(health.ageSeconds, 30);
});

test('never synced is its own answer, not staleness', () => {
  const first = assess([{ sourceAdapterId: 'default', lastSuccessAt: null }], INTERVAL, NOW);
  assert.equal(first.status, 'never-synced');
  assert.equal(first.ageSeconds, null);
  assert.deepEqual(first.stale, ['default']);

  const none = assess([], INTERVAL, NOW);
  assert.equal(none.status, 'never-synced');
});

test('only a truthful dashboard answers 200', () => {
  assert.equal(statusCodeFor('ok'), 200);
  assert.equal(statusCodeFor('stale'), 503);
  assert.equal(statusCodeFor('never-synced'), 503);
});
