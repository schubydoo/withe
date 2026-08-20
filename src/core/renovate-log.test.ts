import assert from 'node:assert/strict';
import { createReadStream, readFileSync } from 'node:fs';
import { test } from 'node:test';

import { classify, extractFromLog, isHeld } from './renovate-log.ts';

const FIXTURE = 'test/fixtures/ce/job.ndjson';
const CONTEXT = {
  repoId: 'src:acme/widget',
  sourceAdapterId: 'src',
  detectedAt: new Date('2026-08-06T17:00:00.000Z'),
};

/** Feed the extractor a string, so a test can shape its own log. */
async function* lines(text: string): AsyncGenerator<string> {
  yield text;
}

/** Feed it in awkward byte chunks, to prove the line splitter handles them. */
async function* chunked(text: string, size: number): AsyncGenerator<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  for (let i = 0; i < bytes.length; i += size) yield bytes.slice(i, i + size);
}

test('the recorded log yields the run version, totals and updates', async () => {
  const extract = await extractFromLog(createReadStream(FIXTURE), CONTEXT);

  assert.match(extract.runnerVersion ?? '', /^\d+\.\d+\.\d+$/);
  assert.ok(extract.totals, 'the recorded run has a summary');
  assert.equal(extract.totals.total, 10);
  assert.equal(extract.totals.vulnerabilityAlerts, 0);
  assert.ok(extract.updates.length > 0);
});

test('a dependency in several package files becomes one row with a count', async () => {
  const extract = await extractFromLog(createReadStream(FIXTURE), CONTEXT);

  const names = extract.updates.map((u) => u.dependencyName);
  assert.equal(new Set(names).size, names.length, 'the same dependency appears twice');

  const multi = extract.updates.find((u) => u.packageFileCount > 1);
  assert.ok(multi, 'the recorded run has one dependency in several files');
  assert.ok(multi.packageFileCount >= 2);
});

test('an open pull request number reaches the update', async () => {
  const extract = await extractFromLog(createReadStream(FIXTURE), CONTEXT);
  const withPr = extract.updates.filter((u) => u.pullRequestNumber !== null);
  assert.ok(withPr.length > 0);
  for (const update of withPr) assert.equal(update.state, 'pr-open');
});

test('abandoned packages are recovered with their last release', async () => {
  const extract = await extractFromLog(createReadStream(FIXTURE), CONTEXT);
  assert.ok(extract.abandoned.length > 0);
  const [first] = extract.abandoned;
  assert.ok(first);
  assert.ok(first.dependency.length > 0);
});

test('a log with no summary means nothing pending, not a failure', async () => {
  const log = [
    JSON.stringify({ msg: 'Renovate started', renovateVersion: '43.280.0' }),
    JSON.stringify({ msg: '0 flattened updates found' }),
    JSON.stringify({ msg: 'Repository finished', result: 'done' }),
  ].join('\n');

  const extract = await extractFromLog(lines(log), CONTEXT);
  assert.equal(extract.totals, null);
  assert.deepEqual(extract.updates, []);
  assert.equal(extract.runnerVersion, '43.280.0');
});

test('lines are found by their fields, not by their message text', async () => {
  const log = JSON.stringify({
    msg: 'a wording Renovate has never used',
    branchesInformation: [
      {
        prNo: 42,
        upgrades: [
          { depName: 'left-pad', currentValue: '1.0.0', newValue: '1.0.1', updateType: 'patch' },
        ],
      },
    ],
  });

  const extract = await extractFromLog(lines(log), CONTEXT);
  assert.equal(extract.updates.length, 1);
  assert.equal(extract.updates[0]?.pullRequestNumber, 42);
});

test('a split byte stream parses the same as a whole one', async () => {
  const text = readFileSync(FIXTURE, 'utf8');
  const whole = await extractFromLog(lines(text), CONTEXT);
  const split = await extractFromLog(chunked(text, 7), CONTEXT);
  assert.deepEqual(split.updates, whole.updates);
  assert.deepEqual(split.totals, whole.totals);
});

test('one malformed line does not lose the run', async () => {
  const log = [
    'this is not JSON',
    JSON.stringify({ renovateVersion: '43.280.0' }),
    '{"truncated": ',
    JSON.stringify({
      branchesInformation: [
        { upgrades: [{ depName: 'left-pad', currentValue: '1.0.0', newValue: '1.0.1' }] },
      ],
    }),
  ].join('\n');

  const extract = await extractFromLog(lines(log), CONTEXT);
  assert.equal(extract.runnerVersion, '43.280.0');
  assert.equal(extract.updates.length, 1);
});

test('classification follows the order the PRD fixes', () => {
  assert.equal(classify({ updateType: 'major', isVulnerabilityAlert: true }), 'security');
  assert.equal(classify({ updateType: 'lockFileMaintenance' }), 'lock-file-maintenance');
  assert.equal(classify({ updateType: 'digest' }), 'digest');
  assert.equal(classify({ updateType: 'pin' }), 'digest');
  assert.equal(
    classify({ updateType: 'major', currentValue: '1.2.3', newValue: '2.0.0' }),
    'major',
  );
  assert.equal(
    classify({ updateType: 'major', currentValue: 'v1.2.3', newValue: 'v4.0.0' }),
    'multiple-major',
  );
  assert.equal(classify({ updateType: 'minor' }), 'minor');
  assert.equal(classify({ updateType: 'patch' }), 'patch');
});

test('an unlabelled upgrade is classified from its versions', () => {
  assert.equal(classify({ currentValue: '1.0.0', newValue: '2.0.0' }), 'major');
  assert.equal(classify({ currentValue: '1.0.0', newValue: '4.0.0' }), 'multiple-major');
  assert.equal(classify({ currentValue: '1.0.0', newValue: '1.0.1' }), 'patch');
  assert.equal(classify({ newValue: '9db594c7a0e82298c121c18b7f08aa1579ce7341' }), 'digest');
});

test('held means major, or minor below 1.0', () => {
  assert.equal(isHeld({ updateType: 'major', currentVersion: '1.0.0' }), true);
  assert.equal(isHeld({ updateType: 'multiple-major', currentVersion: '1.0.0' }), true);
  assert.equal(isHeld({ updateType: 'minor', currentVersion: '0.12.1' }), true);
  assert.equal(isHeld({ updateType: 'minor', currentVersion: 'v0.12.1' }), true);
  assert.equal(isHeld({ updateType: 'minor', currentVersion: '1.4.0' }), false);
  assert.equal(isHeld({ updateType: 'patch', currentVersion: '0.1.0' }), false);
  assert.equal(isHeld({ updateType: 'minor', currentVersion: null }), false);
});

test('one lock-file branch is one refresh, whatever it counts manifests', async () => {
  const log = JSON.stringify({
    branchesInformation: [
      {
        branchName: 'renovate/lock-file-maintenance',
        result: 'not-scheduled',
        upgrades: [
          { packageFile: 'pyproject.toml', updateType: 'lockFileMaintenance' },
          { packageFile: 'package.json', updateType: 'lockFileMaintenance' },
        ],
      },
    ],
  });

  const extract = await extractFromLog(lines(log), CONTEXT);
  assert.equal(extract.updates.length, 1);
  const [update] = extract.updates;
  assert.ok(update);
  assert.equal(update.dependencyName, 'renovate/lock-file-maintenance');
  assert.equal(update.packageFileCount, 2);
  assert.deepEqual(update.packageFiles, ['package.json', 'pyproject.toml']);
  assert.equal(update.updateType, 'lock-file-maintenance');
  assert.equal(update.targetVersion, null);
  assert.equal(isHeld(update), false);
});

test('two lock-file branches stay two refreshes', async () => {
  const log = JSON.stringify({
    branchesInformation: [
      {
        branchName: 'renovate/lock-file-maintenance',
        upgrades: [
          { packageFile: 'Cargo.toml', updateType: 'lockFileMaintenance' },
          { packageFile: 'crates/cli/Cargo.toml', updateType: 'lockFileMaintenance' },
        ],
      },
      {
        branchName: 'renovate/lock-file-maintenance-docs',
        upgrades: [{ packageFile: 'docs/requirements.in', updateType: 'lockFileMaintenance' }],
      },
    ],
  });

  const extract = await extractFromLog(lines(log), CONTEXT);
  assert.equal(extract.updates.length, 2);
  assert.deepEqual(
    extract.updates.map((u) => [u.dependencyName, u.packageFileCount]).sort(),
    [
      ['renovate/lock-file-maintenance', 2],
      ['renovate/lock-file-maintenance-docs', 1],
    ],
  );
  // Each branch names only its own manifests: a text search over the log could
  // not separate them, which is why the paths are carried on the row.
  assert.deepEqual(
    extract.updates.map((u) => u.packageFiles).sort(),
    [['Cargo.toml', 'crates/cli/Cargo.toml'], ['docs/requirements.in']],
  );
});

test('a lock-file refresh on an unnamed branch falls back to its manifest', async () => {
  const log = JSON.stringify({
    branchesInformation: [
      { upgrades: [{ packageFile: 'pyproject.toml', updateType: 'lockFileMaintenance' }] },
    ],
  });

  const extract = await extractFromLog(lines(log), CONTEXT);
  assert.equal(extract.updates.length, 1);
  assert.equal(extract.updates[0]?.dependencyName, 'pyproject.toml');
});

test('an upgrade with neither a name nor a manifest is dropped', async () => {
  const log = JSON.stringify({
    branchesInformation: [{ upgrades: [{ updateType: 'patch', newValue: '1.0.1' }] }],
  });
  const extract = await extractFromLog(lines(log), CONTEXT);
  assert.deepEqual(extract.updates, []);
});
