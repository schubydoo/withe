import assert from 'node:assert/strict';
import { test } from 'node:test';

import { classify, composeBlock, FAMILIES, type Family } from './preflight.ts';

const FAMILY_NAMES = Object.keys(FAMILIES) as Family[];

test('a family that answers produces no problem', () => {
  for (const family of FAMILY_NAMES) {
    assert.equal(classify(family, 200), null, family);
    assert.equal(classify(family, 204), null, family);
  }
});

test('a disabled family names the exact variables that enable it', () => {
  const expected: Record<Family, string[]> = {
    system: ['MEND_RNV_API_ENABLED', 'MEND_RNV_API_ENABLE_SYSTEM'],
    // tad.md 4.4 said this needs only MEND_RNV_API_ENABLED. The specification
    // tags getOrgs `Reporting`, and docs/api.md says the Reporting APIs need
    // MEND_RNV_API_ENABLE_REPORTING too.
    inventory: ['MEND_RNV_API_ENABLED', 'MEND_RNV_API_ENABLE_REPORTING', 'RENOVATE_REPOSITORY_CACHE'],
    // tad.md 4.4 said MEND_RNV_API_ENABLE_JOBS. getRepoJobs is tagged `API`.
    jobs: ['MEND_RNV_API_ENABLED'],
    metrics: ['MEND_RNV_API_ENABLE_PROMETHEUS_METRICS'],
  };

  for (const family of FAMILY_NAMES) {
    const problem = classify(family, 404);
    assert.ok(problem, family);
    assert.deepEqual(
      problem.remedies.map((r) => r.variable).sort(),
      [...(expected[family] ?? [])].sort(),
      family,
    );
  }
});

test('501 is treated the same as 404', () => {
  assert.deepEqual(classify('jobs', 501)?.remedies, classify('jobs', 404)?.remedies);
});

test('the worker-side setting is marked as belonging to the worker', () => {
  const problem = classify('inventory', 404);
  const cache = problem?.remedies.find((r) => r.variable === 'RENOVATE_REPOSITORY_CACHE');
  assert.ok(cache, 'the Reporting APIs need a setting on the Renovate worker, not the server');
  assert.equal(cache.target, 'worker');
  assert.equal(cache.value, 'enabled', 'this one is not a boolean');
});

test('only the inventory family is fatal', () => {
  assert.equal(classify('inventory', 404)?.fatal, true);
  assert.equal(classify('system', 404)?.fatal, false);
  assert.equal(classify('jobs', 404)?.fatal, false);
  assert.equal(classify('metrics', 404)?.fatal, false);
});

test('a non-fatal family says what is lost, so the operator can judge it', () => {
  for (const family of ['system', 'jobs', 'metrics'] as Family[]) {
    const problem = classify(family, 404);
    assert.ok(problem);
    assert.ok(problem.detail.length > 40, `${family} should explain the cost`);
  }
});

test('a rejected credential is separated from a missing permission', () => {
  const rejected = classify('inventory', 401);
  const forbidden = classify('inventory', 403);

  assert.match(rejected?.detail ?? '', /rejected the token.*MEND_RNV_API_SERVER_SECRET/s);
  assert.match(forbidden?.detail ?? '', /accepted but is not permitted/);
  assert.equal(rejected?.setting, 'WITHE_CE_TOKEN');
  assert.equal(forbidden?.setting, 'WITHE_CE_TOKEN');

  // Neither is fixed by a server setting, so offering one would mislead.
  assert.deepEqual(rejected?.remedies, []);
  assert.deepEqual(forbidden?.remedies, []);
});

test('an unexpected status is reported without inventing a cause', () => {
  const problem = classify('inventory', 502);
  assert.match(problem?.detail ?? '', /answered 502/);
  assert.equal(problem?.setting, null);
  assert.deepEqual(problem?.remedies, []);
});

test('the compose block is pasteable and splits the two containers', () => {
  const problems = [classify('inventory', 404), classify('metrics', 404)].filter((p) => p !== null);
  const block = composeBlock(problems);

  assert.equal(
    block,
    [
      'services:',
      '  renovate-server:',
      '    environment:',
      '      MEND_RNV_API_ENABLED: "true"',
      '      MEND_RNV_API_ENABLE_PROMETHEUS_METRICS: "true"',
      '      MEND_RNV_API_ENABLE_REPORTING: "true"',
      '  renovate-worker:',
      '    environment:',
      '      RENOVATE_REPOSITORY_CACHE: "enabled"',
    ].join('\n'),
  );
});

test('a variable needed by two families appears once', () => {
  const problems = [classify('system', 404), classify('inventory', 404)].filter((p) => p !== null);
  const block = composeBlock(problems);
  const occurrences = block.split('\n').filter((l) => l.includes('MEND_RNV_API_ENABLED:')).length;
  assert.equal(occurrences, 1, 'MEND_RNV_API_ENABLED is required by both, and must not be listed twice');
});

test('nothing wrong produces no compose block', () => {
  assert.equal(composeBlock([]), '');
  assert.equal(composeBlock([classify('inventory', 401)].filter((p) => p !== null)), '');
});
