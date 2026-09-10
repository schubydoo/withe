import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { UpdateType } from '../../core/model.ts';
import type { PendingUpdateRow } from '../../db/queries.ts';
import {
  filterByType,
  groupByDependency,
  isActive,
  NO_UPDATE_FILTER,
  readUpdateFilter,
} from './filter.ts';

function row(over: Partial<PendingUpdateRow>): PendingUpdateRow {
  return {
    sourceAdapterId: 's',
    repoFullName: 'acme/widget',
    dependencyName: 'next',
    currentVersion: '15.0.0',
    targetVersion: '16.0.0',
    updateType: 'major',
    datasource: 'npm',
    packageName: 'next',
    prNumber: null,
    packageFileCount: 1,
    ...over,
  };
}

test('readUpdateFilter reads a known type and drops an unknown one', () => {
  assert.deepEqual(readUpdateFilter({ type: 'security' }), { type: 'security' });
  assert.deepEqual(readUpdateFilter({ type: 'nonsense' }), NO_UPDATE_FILTER);
  assert.deepEqual(readUpdateFilter({}), NO_UPDATE_FILTER);
});

test('readUpdateFilter takes the last value of a repeated key', () => {
  assert.deepEqual(readUpdateFilter({ type: ['major', 'minor'] }), { type: 'minor' });
});

test('isActive is true only when a type is set', () => {
  assert.equal(isActive(NO_UPDATE_FILTER), false);
  assert.equal(isActive({ type: 'patch' }), true);
});

test('filterByType keeps every row when no type is set', () => {
  const rows = [row({}), row({ updateType: 'patch' })];
  assert.equal(filterByType(rows, NO_UPDATE_FILTER).length, 2);
});

test('filterByType keeps only the matching type, including security', () => {
  const rows = [
    row({ updateType: 'security' }),
    row({ updateType: 'major' }),
    row({ updateType: 'security', repoFullName: 'acme/other' }),
  ];
  const kept = filterByType(rows, { type: 'security' });
  assert.equal(kept.length, 2);
  assert.ok(kept.every((r) => r.updateType === 'security'));
});

test('groupByDependency lists every repository awaiting one dependency', () => {
  const rows = [
    row({ repoFullName: 'acme/widget' }),
    row({ repoFullName: 'acme/gadget' }),
    row({ dependencyName: 'left-pad', packageName: 'left-pad', repoFullName: 'acme/widget' }),
  ];
  const groups = groupByDependency(rows);
  assert.deepEqual(groups.map((g) => g.dependencyName), ['left-pad', 'next'], 'groups sort by dependency name');
  const next = groups.find((g) => g.dependencyName === 'next');
  assert.deepEqual(next?.rows.map((r) => r.repoFullName), ['acme/gadget', 'acme/widget'], 'rows sort by repository');
});

test('groupByDependency keeps two datasources of the same name apart', () => {
  const rows = [
    row({ dependencyName: 'node', datasource: 'npm', packageName: 'node' }),
    row({ dependencyName: 'node', datasource: 'docker', packageName: 'node' }),
  ];
  const groups = groupByDependency(rows);
  assert.equal(groups.length, 2, 'an npm node and a docker node are different dependencies');
  assert.deepEqual(new Set(groups.map((g) => g.datasource)), new Set(['npm', 'docker']));
});

test('groupByDependency does not merge a name that contains the separator shape', () => {
  // A JSON tuple key cannot be spoofed by a name that looks like the delimiter.
  const rows = [
    row({ dependencyName: 'a', datasource: 'b' }),
    row({ dependencyName: 'a","b', datasource: null }),
  ];
  assert.equal(groupByDependency(rows).length, 2);
});
