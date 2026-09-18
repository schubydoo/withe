import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { CompletedUpdateRow } from '../../db/queries.ts';
import { groupByDependency } from '../updates/filter.ts';
import { byLatestLanding, byNewest, readRepoFilter, rowKey, tally } from './filter.ts';

function row(over: Partial<CompletedUpdateRow>): CompletedUpdateRow {
  return {
    sourceAdapterId: 'src',
    repoFullName: 'acme/widget',
    dependencyName: 'left-pad',
    currentVersion: '1.0.0',
    targetVersion: '1.0.1',
    updateType: 'patch',
    datasource: 'npm',
    packageName: 'left-pad',
    finalState: 'pr-merged',
    prNumber: 1,
    closedAt: new Date('2026-09-01T00:00:00Z'),
    ...over,
  };
}

test('readRepoFilter treats an absent, empty or blank value as the whole fleet', () => {
  assert.equal(readRepoFilter({}), null);
  assert.equal(readRepoFilter({ repo: '' }), null);
  assert.equal(readRepoFilter({ repo: '   ' }), null);
  assert.equal(readRepoFilter({ repo: 'acme/widget' }), 'acme/widget');
});

test('readRepoFilter reads the last value, the way a resubmitted form leaves it', () => {
  assert.equal(readRepoFilter({ repo: ['acme/widget', 'acme/gadget'] }), 'acme/gadget');
});

test('rows read newest first', () => {
  const rows = [
    row({ repoFullName: 'acme/old', closedAt: new Date('2026-08-01T00:00:00Z') }),
    row({ repoFullName: 'acme/new', closedAt: new Date('2026-09-10T00:00:00Z') }),
    row({ repoFullName: 'acme/mid', closedAt: new Date('2026-09-01T00:00:00Z') }),
  ].sort(byNewest);
  assert.deepEqual(rows.map((r) => r.repoFullName), ['acme/new', 'acme/mid', 'acme/old']);
});

test('two updates landing at the same instant stay in a stable order', () => {
  const at = new Date('2026-09-01T00:00:00Z');
  const rows = [
    row({ repoFullName: 'acme/zebra', closedAt: at }),
    row({ repoFullName: 'acme/apple', closedAt: at }),
  ].sort(byNewest);
  assert.deepEqual(rows.map((r) => r.repoFullName), ['acme/apple', 'acme/zebra']);
});

test('dependencies read by their most recent landing, not alphabetically', () => {
  // `astro` is alphabetically first but landed longest ago.
  const groups = groupByDependency(
    [
      row({ dependencyName: 'astro', repoFullName: 'acme/a', closedAt: new Date('2026-08-01T00:00:00Z') }),
      row({ dependencyName: 'zod', repoFullName: 'acme/b', closedAt: new Date('2026-09-10T00:00:00Z') }),
      row({ dependencyName: 'next', repoFullName: 'acme/c', closedAt: new Date('2026-09-05T00:00:00Z') }),
    ],
    { rows: byNewest, groups: byLatestLanding },
  );
  assert.deepEqual(groups.map((g) => g.dependencyName), ['zod', 'next', 'astro']);
});

test('a dependency is placed by its newest row, not by the one that arrived first', () => {
  const groups = groupByDependency(
    [
      // `next` is listed oldest-first, so a grouping that read rows[0] before
      // sorting them would rank it below `zod`.
      row({ dependencyName: 'next', repoFullName: 'acme/a', closedAt: new Date('2026-07-01T00:00:00Z') }),
      row({ dependencyName: 'next', repoFullName: 'acme/b', closedAt: new Date('2026-09-20T00:00:00Z') }),
      row({ dependencyName: 'zod', repoFullName: 'acme/c', closedAt: new Date('2026-09-10T00:00:00Z') }),
    ],
    { rows: byNewest, groups: byLatestLanding },
  );
  assert.deepEqual(groups.map((g) => g.dependencyName), ['next', 'zod']);
  assert.deepEqual(groups[0]?.rows.map((r) => r.repoFullName), ['acme/b', 'acme/a']);
});

test('an npm package and a Docker image of the same name stay apart', () => {
  const groups = groupByDependency(
    [
      row({ dependencyName: 'node', datasource: 'npm' }),
      row({ dependencyName: 'node', datasource: 'docker' }),
    ],
    { rows: byNewest, groups: byLatestLanding },
  );
  assert.equal(groups.length, 2);
});

test('two version pairs under one pull request get different row keys', () => {
  // The archive keeps both of these on purpose, and they group together here
  // because the group key is the dependency. A key without the version pair
  // makes them identical siblings in one array.
  const shared = { dependencyName: 'next', targetVersion: '16.0.0', updateType: 'major' as const, prNumber: 50 };
  const a = row({ ...shared, currentVersion: '15.0.0' });
  const b = row({ ...shared, currentVersion: '15.2.0' });
  assert.notEqual(rowKey(a), rowKey(b));
});

test('the row key separates every field the store separates', () => {
  const base = row({});
  for (const change of [
    { sourceAdapterId: 'other' },
    { repoFullName: 'acme/other' },
    { dependencyName: 'other' },
    { prNumber: 999 },
    { currentVersion: '9.9.9' },
    { targetVersion: '9.9.9' },
    { updateType: 'minor' as const },
  ]) {
    assert.notEqual(rowKey(row(change)), rowKey(base), `${Object.keys(change)[0]} does not change the key`);
  }
});

test('two records alike in every keyed field share a key', () => {
  // The negative half: the test above passes trivially if the key were random.
  assert.equal(rowKey(row({})), rowKey(row({})));
});

test('a lock-file refresh, which names no versions, still gets a key', () => {
  const lock = row({
    dependencyName: 'uv.lock',
    currentVersion: null,
    targetVersion: null,
    updateType: 'lock-file-maintenance',
  });
  assert.ok(rowKey(lock).length > 0);
  // Two lock-file refreshes in one repository are told apart by their pull
  // request, which is the only thing that differs between them.
  assert.notEqual(rowKey(lock), rowKey({ ...lock, prNumber: lock.prNumber + 1 }));
});

test('a value cannot straddle two fields and forge a collision', () => {
  // The separator earns its place here: without it, these two would both
  // flatten to the same string.
  assert.notEqual(
    rowKey(row({ currentVersion: '1.0', targetVersion: '' })),
    rowKey(row({ currentVersion: '1', targetVersion: '0' })),
  );
});

test('the tally separates what landed from what Renovate abandoned', () => {
  const counts = tally([
    row({ finalState: 'pr-merged' }),
    row({ finalState: 'pr-merged' }),
    row({ finalState: 'pr-closed' }),
  ]);
  assert.deepEqual(counts, { merged: 2, closed: 1 });
});

test('an empty history tallies to nothing rather than throwing', () => {
  assert.deepEqual(tally([]), { merged: 0, closed: 0 });
});
