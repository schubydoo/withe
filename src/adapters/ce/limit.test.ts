import assert from 'node:assert/strict';
import { test } from 'node:test';

import { mapWithLimit } from './limit.ts';

test('never exceeds the limit and preserves order', async () => {
  let inFlight = 0;
  let peak = 0;
  const items = Array.from({ length: 20 }, (_, i) => i);

  const out = await mapWithLimit(items, 4, async (n) => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await new Promise((r) => setTimeout(r, n % 3));
    inFlight -= 1;
    return n * 2;
  });

  assert.equal(peak, 4);
  assert.deepEqual(out, items.map((n) => n * 2));
});

test('a rejecting task rejects the whole call', async () => {
  await assert.rejects(
    mapWithLimit([1, 2, 3], 2, async (n) => {
      if (n === 2) throw new Error('boom');
      return n;
    }),
    /boom/,
  );
});

test('an empty list does no work', async () => {
  assert.deepEqual(await mapWithLimit([], 4, async () => 1), []);
});
