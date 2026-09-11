import assert from 'node:assert/strict';
import { test } from 'node:test';

import { headroomFraction, headroomPercent, isLow, rateLimitBannerText, RATE_LIMIT_LOW } from './rate-limit.ts';

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

test('rateLimitBannerText warns only when low, naming the numbers', () => {
  assert.equal(rateLimitBannerText(4000, 5000, null), null, 'plenty of headroom says nothing');
  const low = rateLimitBannerText(150, 1000, null);
  assert.match(low ?? '', /low/i);
  assert.match(low ?? '', /150 of 1000/);
  assert.match(low ?? '', /15%/);
});

test('rateLimitBannerText stays silent when the limit is unknown', () => {
  assert.equal(rateLimitBannerText(0, 0, null), null);
});

test('rateLimitBannerText drops a low reading whose window has already reset', () => {
  const now = new Date('2026-09-11T12:00:00Z');
  const passed = new Date('2026-09-11T11:00:00Z');
  const future = new Date('2026-09-11T12:30:00Z');
  assert.equal(rateLimitBannerText(150, 1000, passed, now), null, 'a reset in the past is stale, not a warning');
  assert.match(rateLimitBannerText(150, 1000, future, now) ?? '', /low/i, 'a live window still warns');
});
