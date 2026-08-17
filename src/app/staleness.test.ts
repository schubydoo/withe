import assert from 'node:assert/strict';
import { test } from 'node:test';

import { STALE_AFTER_INTERVALS } from '../core/health.ts';
import { bannerText, describeAge, isStale, MIN_POLL_SECONDS, pollIntervalMs } from './staleness.ts';

test('describeAge names the age in words that grow', () => {
  assert.equal(describeAge(0), 'less than a minute old');
  assert.equal(describeAge(59), 'less than a minute old');
  assert.equal(describeAge(60), '1 minute old');
  assert.equal(describeAge(130), '2 minutes old');
  assert.equal(describeAge(3600), '1 hour old');
  assert.equal(describeAge(7200), '2 hours old');
  assert.equal(describeAge(172_800), '2 days old');
});

test('describeAge floors a negative age rather than reading backwards', () => {
  assert.equal(describeAge(-10), 'less than a minute old');
});

test('isStale uses the shared threshold, not a local number', () => {
  const interval = 300;
  const limit = interval * STALE_AFTER_INTERVALS;
  assert.equal(isStale(limit, interval), false, 'exactly at the limit is not yet stale');
  assert.equal(isStale(limit + 1, interval), true);
  assert.equal(isStale(limit - 1, interval), false);
});

test('isStale treats never-synced (null age) as not stale', () => {
  assert.equal(isStale(null, 300), false);
});

test('pollIntervalMs derives from the sync interval and floors tiny values', () => {
  assert.equal(pollIntervalMs(300), 300_000);
  assert.equal(pollIntervalMs(5), MIN_POLL_SECONDS * 1000);
  assert.equal(pollIntervalMs(undefined), 60_000);
  assert.equal(pollIntervalMs(0), 60_000);
});

test('bannerText names never-synced as its own state, not staleness', () => {
  assert.equal(
    bannerText('never-synced', null, 300),
    'Withe has never completed a sync. Everything shown is empty rather than out of date.',
  );
});

test('bannerText reports an unreadable database as a distinct problem', () => {
  assert.equal(
    bannerText('unreadable', null, 300),
    'Withe cannot read its database, so what is shown may be out of date.',
  );
});

test('bannerText stays silent while data is fresh', () => {
  assert.equal(bannerText('ok', 120, 300), null);
});

test('bannerText warns with the aging phrase once data crosses the threshold', () => {
  assert.equal(
    bannerText('ok', 1000, 300),
    'Data is 17 minutes old. It may not reflect what Renovate has done since.',
  );
});

test('bannerText re-derives staleness from age even when the server still says ok', () => {
  // 1000s against a 300s interval is past 3 intervals: the client does not wait
  // for the server's next poll to agree.
  assert.notEqual(bannerText('ok', 1000, 300), null);
});

test('bannerText shows nothing for an unknown status with no stale age', () => {
  assert.equal(bannerText('something-new', 10, 300), null);
});
