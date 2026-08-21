import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { ForgeInfo, LockFileRefreshRow, PendingUpdateRow } from '../db/queries.ts';
import { foldLock, foldUpdate } from './collapse.ts';

const withForge = new Map<string, ForgeInfo>([
  ['ce', { platform: 'github', webBaseUrl: 'https://github.example' }],
  ['logs', { platform: null, webBaseUrl: null }],
]);

function update(over: Partial<PendingUpdateRow>): PendingUpdateRow {
  return {
    sourceAdapterId: 'ce',
    repoFullName: 'acme/gadget',
    dependencyName: 'left-pad',
    currentVersion: '1.0.0',
    targetVersion: '1.0.1',
    updateType: 'patch',
    datasource: 'npm',
    packageName: 'left-pad',
    prNumber: null,
    packageFileCount: 1,
    ...over,
  };
}

function lock(over: Partial<LockFileRefreshRow>): LockFileRefreshRow {
  return {
    sourceAdapterId: 'ce',
    repoFullName: 'acme/gadget',
    branchName: 'renovate/lock-file-maintenance',
    packageFileCount: 1,
    packageFiles: [],
    prNumber: null,
    ...over,
  };
}

test('foldUpdate keeps the forge-bearing copy and fills the PR from another copy', () => {
  // The reviewer's case: a stale server holds the forge but has not seen the PR;
  // a fresher log directory has the PR but no forge. Neither whole row is right.
  const group = [
    update({ sourceAdapterId: 'ce', prNumber: null, packageFileCount: 1 }),
    update({ sourceAdapterId: 'logs', prNumber: 42, packageFileCount: 3 }),
  ];
  const folded = foldUpdate(group, withForge);
  assert.equal(folded.sourceAdapterId, 'ce', 'the forge-bearing source is the base, so info() can link');
  assert.equal(folded.prNumber, 42, 'the pull request is filled from the copy that saw it');
  assert.equal(folded.packageFileCount, 3, 'the fuller manifest count wins');
});

test('foldUpdate is order-independent — the PR-bearing copy can be first', () => {
  const group = [
    update({ sourceAdapterId: 'logs', prNumber: 42 }),
    update({ sourceAdapterId: 'ce', prNumber: null }),
  ];
  const folded = foldUpdate(group, withForge);
  assert.equal(folded.sourceAdapterId, 'ce');
  assert.equal(folded.prNumber, 42);
});

test('foldUpdate keeps the base PR when it has one', () => {
  const group = [update({ sourceAdapterId: 'ce', prNumber: 7 }), update({ sourceAdapterId: 'logs', prNumber: 9 })];
  assert.equal(foldUpdate(group, withForge).prNumber, 7, 'the forge-bearing copy\'s own PR is not overwritten');
});

test('foldUpdate falls back to the first copy when no source has a forge', () => {
  const group = [update({ sourceAdapterId: 'logs', prNumber: null }), update({ sourceAdapterId: 'other', prNumber: 7 })];
  const folded = foldUpdate(group, new Map());
  assert.equal(folded.sourceAdapterId, 'logs', 'the first copy is the base when none links');
  assert.equal(folded.prNumber, 7, 'the PR is still recovered');
});

test('foldLock merges the PR and the fullest manifest list onto the forge-bearing copy', () => {
  const group = [
    lock({ sourceAdapterId: 'ce', prNumber: null, packageFileCount: 1, packageFiles: ['a'] }),
    lock({ sourceAdapterId: 'logs', prNumber: 9, packageFileCount: 2, packageFiles: ['a', 'b'] }),
  ];
  const folded = foldLock(group, withForge);
  assert.equal(folded.sourceAdapterId, 'ce');
  assert.equal(folded.prNumber, 9);
  assert.equal(folded.packageFileCount, 2);
  assert.deepEqual(folded.packageFiles, ['a', 'b']);
});
