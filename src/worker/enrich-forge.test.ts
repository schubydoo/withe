import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ForgeError, type GithubForge, type PullRequestSnapshot } from '../adapters/forge/github.ts';
import type { RenovatePrRule } from '../adapters/forge/renovate-pr.ts';
import type { CollectResult, SourceMeta } from '../adapters/types.ts';
import type { Repo, Update } from '../core/model.ts';
import { enrichForgeState } from './enrich-forge.ts';

const RULE: RenovatePrRule = { branchPrefix: 'renovate/', authorLogins: ['renovate[bot]', 'renovate'] };

const GITHUB_META: SourceMeta = {
  platform: 'github',
  webBaseUrl: 'https://github.com',
  scheduleCron: null,
  scheduleLastAt: null,
  system: null,
};

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

/**
 * A forge that answers each `owner/repo#number` from a table and records every
 * read, so a test can assert what was and was not probed.
 */
function fakeForge(
  replies: Record<string, PullRequestSnapshot | null | Error>,
  calls: string[] = [],
): GithubForge {
  return {
    async pullRequest(owner, name, number) {
      calls.push(`${owner}/${name}#${number}`);
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

function fleet(updates: Update[], meta: SourceMeta | null = GITHUB_META): CollectResult {
  const names = [...new Set(updates.map((u) => u.repoId.slice(2)))];
  return {
    repos: names.map(repo),
    runs: [],
    updates,
    warnings: [],
    complete: true,
    authoritativeRepoList: true,
    ...(meta ? { meta } : {}),
  };
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
  const calls: string[] = [];
  await enrichForgeState(result, fakeForge({}, calls), RULE);
  assert.deepEqual(calls, [], 'a detected update carries no pull request, so nothing is read');
  assert.equal(result.updates[0]?.state, 'detected');
});

test('a source that reports another forge is skipped silently, with no read and no warning', async () => {
  const result = fleet([update('acme/widget', { pullRequestNumber: 7 })], { ...GITHUB_META, platform: 'gitlab' });
  const calls: string[] = [];
  const warnings = await enrichForgeState(result, fakeForge({}, calls), RULE, true);
  assert.deepEqual(calls, [], 'a non-GitHub source is not read');
  assert.equal(result.updates[0]?.state, 'pr-open');
  assert.deepEqual(warnings, [], 'a permanent config mismatch is not a per-cycle degradation');
});

test('a source that cannot say its platform is skipped when no host is named', async () => {
  const result = fleet([update('acme/widget', { pullRequestNumber: 7 })], null);
  const calls: string[] = [];
  const warnings = await enrichForgeState(result, fakeForge({}, calls), RULE, false);
  assert.deepEqual(calls, [], 'without a named host an unknown-forge source is not read');
  assert.equal(result.updates[0]?.state, 'pr-open');
  assert.deepEqual(warnings, []);
});

test('a GitHub Enterprise source is not read against public GitHub until the host is named', async () => {
  // GHES reports platform 'github' with its own host, so the kind alone is not
  // enough: the default api.github.com is wrong for it.
  const ghes: SourceMeta = { ...GITHUB_META, webBaseUrl: 'https://ghe.example.com' };

  const unnamed = fleet([update('acme/widget', { pullRequestNumber: 7 })], ghes);
  const calls: string[] = [];
  await enrichForgeState(unnamed, fakeForge({}, calls), RULE, false);
  assert.deepEqual(calls, [], 'a non-github.com host with no named base is not read');
  assert.equal(unnamed.updates[0]?.state, 'pr-open');

  const named = fleet([update('acme/widget', { pullRequestNumber: 7 })], ghes);
  await enrichForgeState(
    named,
    fakeForge({ 'acme/widget#7': { state: 'merged', closeType: 'merge', closedAt: new Date(), ...RENOVATE } }),
    RULE,
    true,
  );
  assert.equal(named.updates[0]?.state, 'pr-merged', 'naming the host with WITHE_GITHUB_API_URL enables GHES');
});

test('a source that cannot say its platform is enriched when the host is named', async () => {
  const result = fleet([update('acme/widget', { pullRequestNumber: 7 })], null);
  await enrichForgeState(
    result,
    fakeForge({ 'acme/widget#7': { state: 'merged', closeType: 'merge', closedAt: new Date(), ...RENOVATE } }),
    RULE,
    true,
  );
  assert.equal(result.updates[0]?.state, 'pr-merged', 'a named host lets a log-directory GitHub fleet refresh');
});

test('a permission 403 warns about one repository and does not stop the others', async () => {
  const result = fleet([
    update('acme/denied', { pullRequestNumber: 1 }),
    update('acme/ok', { pullRequestNumber: 2 }),
  ]);
  const warnings = await enrichForgeState(
    result,
    fakeForge({
      // rateLimited defaults to false: a missing grant, not a spent limit.
      'acme/denied#1': new ForgeError(403, 'Resource not accessible by integration'),
      'acme/ok#2': { state: 'merged', closeType: 'merge', closedAt: new Date(), ...RENOVATE },
    }),
    RULE,
  );
  const denied = result.updates.find((u) => u.repoId === 's:acme/denied');
  const ok = result.updates.find((u) => u.repoId === 's:acme/ok');
  assert.equal(denied?.state, 'pr-open', 'the repository Withe cannot read keeps the log state');
  assert.equal(ok?.state, 'pr-merged', 'a later repository is still refreshed');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0] ?? '', /acme\/denied#1/);
  assert.doesNotMatch(warnings[0] ?? '', /rate limit/i);
});

test('a rate-limit reply stops further reads and warns once', async () => {
  // More candidates than CONCURRENCY (6), so a second wave exists to skip.
  const updates = Array.from({ length: 8 }, (_, i) => update(`acme/r${i}`, { pullRequestNumber: i + 1 }));
  const replies: Record<string, Error> = {};
  for (let i = 0; i < 8; i += 1) replies[`acme/r${i}#${i + 1}`] = new ForgeError(403, 'rate limit', true);

  const result = fleet(updates);
  const calls: string[] = [];
  const warnings = await enrichForgeState(result, fakeForge(replies, calls), RULE);

  assert.equal(warnings.length, 1, 'one warning for the whole pass, not one per pull request');
  assert.match(warnings[0] ?? '', /rate limit/i);
  assert.ok(result.updates.every((u) => u.state === 'pr-open'));
  assert.ok(calls.length < updates.length, 'the pass stopped early rather than reading every candidate');
});
