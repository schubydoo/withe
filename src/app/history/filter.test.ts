import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { CompletedUpdateRow } from '../../db/queries.ts';
import { groupByDependency } from '../updates/filter.ts';
import { byLatestLanding, byNewest, readRepoFilter, tally } from './filter.ts';

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

test('a row with no date sorts oldest rather than first', () => {
  const rows = [
    row({ repoFullName: 'acme/undated', closedAt: null }),
    row({ repoFullName: 'acme/dated', closedAt: new Date('2026-08-01T00:00:00Z') }),
  ].sort(byNewest);
  assert.deepEqual(rows.map((r) => r.repoFullName), ['acme/dated', 'acme/undated']);
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
