import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { mapArtifactErrors, mapError, mapInstallStatus, mapRepo, mapRun, mapRunStatus } from './map.ts';
import type { components } from './generated/ce.d.ts';

type JobReport = components['schemas']['JobReport'];
type RepositoryInfo = components['schemas']['RepositoryInfo'];

const load = <T,>(name: string): T =>
  JSON.parse(readFileSync(`test/fixtures/ce/${name}.json`, 'utf8')) as T;

const recordedJobs = load<JobReport[]>('jobs-page1');
const recordedRepos = load<RepositoryInfo[]>('repos');
const [failedJob, queuedJob] = load<JobReport[]>('jobs-synthetic');

test('a recorded successful run maps with no error and no artifact errors', () => {
  const job = recordedJobs[0];
  assert.ok(job, 'fixture is empty');
  const run = mapRun('src:acme/widget', job, 'src');

  assert.ok(run);
  assert.equal(run.status, 'success');
  assert.equal(run.error, null);
  assert.deepEqual(run.artifactErrors, []);
  assert.equal(run.externalJobId, job.jobId);
  assert.ok(run.startedAt instanceof Date);
  assert.ok(run.completedAt instanceof Date);
  assert.equal(run.sourceAdapterId, 'src');
  // The jobs endpoint does not report it; the log does, in Task 1.11.
  assert.equal(run.runnerVersion, null);
});

test('every recorded run maps without throwing', () => {
  const runs = recordedJobs.map((job) => mapRun('src:acme/widget', job, 'src'));
  assert.equal(runs.filter(Boolean).length, recordedJobs.length);
});

test('a failed run keeps its error and flattens artifact errors to lines', () => {
  assert.ok(failedJob);
  const run = mapRun('src:acme/widget', failedJob, 'src');

  assert.ok(run);
  assert.equal(run.status, 'failed');
  assert.equal(run.error, 'ExternalHostError: Host error for https://registry.example/api');
  assert.deepEqual(run.artifactErrors, ['package.json: npm ERR! code ERESOLVE', 'uv.lock']);
});

test('a queued run has no start or completion', () => {
  assert.ok(queuedJob);
  const run = mapRun('src:acme/widget', queuedJob, 'src');

  assert.ok(run);
  assert.equal(run.status, 'queued');
  assert.equal(run.startedAt, null);
  assert.equal(run.completedAt, null);
  assert.ok(run.queuedAt instanceof Date);
});

test('a run with no id is dropped rather than stored unaddressable', () => {
  assert.equal(mapRun('src:acme/widget', { reason: 'manual' }, 'src'), null);
});

test('recorded repositories map to the internal shape', () => {
  const repos = recordedRepos.map((info) => mapRepo('acme', info, 'src'));
  assert.equal(repos.length, recordedRepos.length);
  const first = repos[0];
  assert.ok(first);
  assert.equal(first.org, 'acme');
  assert.match(first.fullName, /^acme\//);
  assert.equal(first.sourceAdapterId, 'src');
  assert.ok(['activated', 'onboarded', 'onboarding', 'disabled', 'unknown'].includes(first.installStatus));
});

test('an unrecognised run status becomes unknown, never failed', () => {
  assert.equal(mapRunStatus('something-new'), 'unknown');
  assert.equal(mapRunStatus(undefined), 'unknown');
  assert.equal(mapRunStatus('error'), 'failed');
});

test('states the model does not carry land on unknown', () => {
  assert.equal(mapInstallStatus('resource-limit'), 'unknown');
  assert.equal(mapInstallStatus('timeout'), 'unknown');
  assert.equal(mapInstallStatus('failed'), 'unknown');
  assert.equal(mapInstallStatus('activated'), 'activated');
});

test('a half-filled error still produces a line', () => {
  assert.equal(mapError({ name: 'Err', message: '' } as never), 'Err');
  assert.equal(mapError(undefined), null);
  assert.deepEqual(mapArtifactErrors(undefined), []);
  assert.deepEqual(mapArtifactErrors({ npm: [{}] } as never), []);
});
