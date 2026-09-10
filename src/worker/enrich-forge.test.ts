import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ForgeError, type GithubForge, type PullRequestSnapshot } from '../adapters/forge/github.ts';
import type { RenovatePrRule } from '../adapters/forge/renovate-pr.ts';
import type { CollectResult } from '../adapters/types.ts';
import type { Repo, Update } from '../core/model.ts';
import { enrichForgeState } from './enrich-forge.ts';

const RULE: RenovatePrRule = { branchPrefix: 'renovate/', authorLogins: ['renovate[bot]', 'renovate'] };

function repo(fullName: string): Repo {
  const [org = '', name = ''] = fullName.split('/');
  return {
    id: `s:${fullName}`,
    org,
    name,
    fullName,
    enabled: true,
    installStatus: 'activated',
    queueName: null,
    installedAt: null,
    removedAt: null,
    sourceAdapterId: 's',
  };
}

function update(fullName: string, over: Partial<Update>): Update {
  return {
    id: `s:${fullName}:${over.dependencyName ?? 'dep'}`,
    repoId: `s:${fullName}`,
    dependencyName: over.dependencyName ?? 'dep',
    currentVersion: '1.0.0',
    targetVersion: '1.1.0',
    updateType: 'minor',
    datasource: 'npm',
    packageName: over.dependencyName ?? 'dep',
    state: 'pr-open',
    pullRequestUrl: null,
    pullRequestNumber: 1,
    closedAt: null,
    closeType: null,
    detectedAt: new Date('2026-09-01T00:00:00Z'),
    packageFileCount: 1,
    packageFiles: [],
    sourceAdapterId: 's',
    ...over,
  };
}

const RENOVATE = { headRef: 'renovate/dep-1.x', authorLogin: 'renovate[bot]' } as const;

/** A forge that answers each `owner/repo#number` from a table. */
function fakeForge(replies: Record<string, PullRequestSnapshot | null | Error>): GithubForge {
  return {
    async pullRequest(owner, name, number) {
      const value = replies[`${owner}/${name}#${number}`];
      if (value instanceof Error) throw value;
      return value ?? null;
    },
    async commitStatus() {
      return 'none';
    },
    headroom() {
      return null;
    },
  };
}

function fleet(updates: Update[]): CollectResult {
  const names = [...new Set(updates.map((u) => u.repoId.slice(2)))];
  return { repos: names.map(repo), runs: [], updates, warnings: [], complete: true, authoritativeRepoList: true };
}

test('a merged pull request marks the update merged', async () => {
  const result = fleet([update('acme/widget', { pullRequestNumber: 7 })]);
  const closedAt = new Date('2026-09-02T10:00:00Z');
  const warnings = await enrichForgeState(
    result,
    fakeForge({ 'acme/widget#7': { state: 'merged', closeType: 'merge', closedAt, ...RENOVATE } }),
    RULE,
  );
  assert.deepEqual(warnings, []);
  assert.equal(result.updates[0]?.state, 'pr-merged');
  assert.equal(result.updates[0]?.closeType, 'merge');
  assert.equal(result.updates[0]?.closedAt, closedAt);
});

test('a closed but unmerged pull request marks the update closed', async () => {
  const result = fleet([update('acme/widget', { pullRequestNumber: 7 })]);
  await enrichForgeState(
    result,
    fakeForge({ 'acme/widget#7': { state: 'closed', closeType: 'close', closedAt: new Date(), ...RENOVATE } }),
    RULE,
  );
  assert.equal(result.updates[0]?.state, 'pr-closed');
});

test('a still-open pull request is left as it was', async () => {
  const result = fleet([update('acme/widget', { pullRequestNumber: 7 })]);
  await enrichForgeState(
    result,
    fakeForge({ 'acme/widget#7': { state: 'open', closeType: null, closedAt: null, ...RENOVATE } }),
    RULE,
  );
  assert.equal(result.updates[0]?.state, 'pr-open');
});

test('a pull request that is not Renovate is not touched, even when merged', async () => {
  const result = fleet([update('acme/widget', { pullRequestNumber: 7 })]);
  await enrichForgeState(
    result,
    fakeForge({ 'acme/widget#7': { state: 'merged', closeType: 'merge', closedAt: new Date(), headRef: 'feature/x', authorLogin: 'a-human' } }),
    RULE,
  );
  assert.equal(result.updates[0]?.state, 'pr-open');
});

test('a gone pull request (404) keeps the log state', async () => {
  const result = fleet([update('acme/widget', { pullRequestNumber: 7 })]);
  await enrichForgeState(result, fakeForge({ 'acme/widget#7': null }), RULE);
  assert.equal(result.updates[0]?.state, 'pr-open');
});

test('an update with no pull request is never probed', async () => {
  const result = fleet([update('acme/widget', { state: 'detected', pullRequestNumber: null })]);
  await enrichForgeState(
    result,
    // Any read would be a bug, so answer with a throw that would surface as a warning.
    fakeForge({}),
    RULE,
  );
  assert.equal(result.updates[0]?.state, 'detected');
});

test('a forge error on one pull request is a warning, not a crash', async () => {
  const result = fleet([update('acme/widget', { pullRequestNumber: 7 })]);
  const warnings = await enrichForgeState(
    result,
    fakeForge({ 'acme/widget#7': new ForgeError(500, 'boom') }),
    RULE,
  );
  assert.equal(result.updates[0]?.state, 'pr-open');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0] ?? '', /acme\/widget#7/);
});

test('a rate-limit error stops further reads and warns once', async () => {
  const result = fleet([
    update('acme/a', { pullRequestNumber: 1 }),
    update('acme/b', { pullRequestNumber: 2 }),
  ]);
  const warnings = await enrichForgeState(
    result,
    fakeForge({
      'acme/a#1': new ForgeError(403, 'rate limit'),
      'acme/b#2': new ForgeError(403, 'rate limit'),
    }),
    RULE,
  );
  assert.equal(warnings.length, 1, 'one warning for the whole cycle, not one per pull request');
  assert.match(warnings[0] ?? '', /rate limit/i);
  assert.ok(result.updates.every((u) => u.state === 'pr-open'));
});
