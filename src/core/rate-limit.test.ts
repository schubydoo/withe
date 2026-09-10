import assert from 'node:assert/strict';
import { test } from 'node:test';

import { headroomFraction, headroomPercent, isLow, RATE_LIMIT_LOW } from './rate-limit.ts';

test('headroomFraction is remaining over limit', () => {
  assert.equal(headroomFraction(500, 1000), 0.5);
  assert.equal(headroomFraction(5000, 5000), 1);
});

test('an unknown or zero limit is null, not a division', () => {
  assert.equal(headroomFraction(0, 0), null);
  assert.equal(headroomFraction(5, -1), null);
  assert.equal(headroomFraction(5, Number.NaN), null);
});

test('isLow uses the shared threshold, exclusive at the edge', () => {
  const limit = 1000;
  const edge = RATE_LIMIT_LOW * limit;
  assert.equal(isLow(edge, limit), false, 'exactly at the threshold is not low');
  assert.equal(isLow(edge - 1, limit), true);
  assert.equal(isLow(edge + 1, limit), false);
});

test('unknown headroom is not low, so a missing limit raises no false alarm', () => {
  assert.equal(isLow(0, 0), false);
});

test('headroomPercent is a whole number, or null when it cannot be computed', () => {
  assert.equal(headroomPercent(150, 1000), 15);
  assert.equal(headroomPercent(5000, 5000), 100);
  assert.equal(headroomPercent(1, 0), null);
});
