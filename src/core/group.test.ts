import assert from 'node:assert/strict';
import { test } from 'node:test';

import { collapseBy, distinctSources, groupByFullName } from './group.ts';

interface Row {
  sourceAdapterId: string;
  fullName: string;
  lastRunAt: Date | null;
  removedAt: Date | null;
}

function row(over: Partial<Row> = {}): Row {
  return { sourceAdapterId: 'ce', fullName: 'acme/widget', lastRunAt: null, removedAt: null, ...over };
}

test('two sources describing one repository become one entry naming both', () => {
  const grouped = groupByFullName([
    row({ sourceAdapterId: 'home-ce', lastRunAt: new Date('2026-08-20T07:00:00Z') }),
    row({ sourceAdapterId: 'cron-logs', lastRunAt: new Date('2026-08-20T08:00:00Z') }),
    row({ sourceAdapterId: 'home-ce', fullName: 'acme/gadget' }),
  ]);

  assert.equal(grouped.length, 2);
  const widget = grouped.find((g) => g.primary.fullName === 'acme/widget');
  assert.deepEqual(widget?.sources, ['cron-logs', 'home-ce']);
  assert.equal(widget?.primary.sourceAdapterId, 'cron-logs', 'the freshest observer wins');
});

test('a repository is alive while any contributor still lists it', () => {
  const grouped = groupByFullName([
    // The removed row has the newer run — freshness alone would pick it and
    // wrongly badge a living repository as removed.
    row({ sourceAdapterId: 'old-ce', removedAt: new Date(0), lastRunAt: new Date('2026-08-20T08:00:00Z') }),
    row({ sourceAdapterId: 'cron-logs', lastRunAt: new Date('2026-08-20T07:00:00Z') }),
  ]);

  assert.equal(grouped[0]?.primary.sourceAdapterId, 'cron-logs');
  assert.equal(grouped[0]?.primary.removedAt, null);
});

test('a repository every contributor removed stays removed', () => {
  const grouped = groupByFullName([row({ removedAt: new Date(0) })]);
  assert.ok(grouped[0]?.primary.removedAt);
});

test('one source changes nothing: every group has one contributor', () => {
  const grouped = groupByFullName([row(), row({ fullName: 'acme/gadget' })]);
  assert.deepEqual(grouped.map((g) => g.sources), [['ce'], ['ce']]);
});

test('distinctSources names each source once, sorted', () => {
  assert.deepEqual(
    distinctSources([row(), row({ sourceAdapterId: 'cron-logs' }), row()]),
    ['ce', 'cron-logs'],
  );
});

test('collapseBy folds each identity group and holds first-seen order', () => {
  const rows = [
    { id: 'a', n: 1 },
    { id: 'b', n: 2 },
    { id: 'a', n: 5 },
  ];
  // fold takes the whole group; here it sums, to prove both copies reach it.
  assert.deepEqual(
    collapseBy(rows, (r) => r.id, (g) => ({ id: g[0]!.id, n: g.reduce((s, r) => s + r.n, 0) })),
    [{ id: 'a', n: 6 }, { id: 'b', n: 2 }],
  );
});

test('collapseBy passes a one-row group for a distinct identity', () => {
  const rows = [{ id: 'a', n: 1 }, { id: 'b', n: 2 }];
  assert.deepEqual(
    collapseBy(rows, (r) => r.id, (g) => g[0]!),
    rows,
  );
});
