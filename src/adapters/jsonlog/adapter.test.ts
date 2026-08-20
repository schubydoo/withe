import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { JsonLogAdapter } from './adapter.ts';

const roots: string[] = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function dir(): string {
  const root = mkdtempSync(join(tmpdir(), 'withe-jsonlog-'));
  roots.push(root);
  return root;
}

function adapter(path: string): JsonLogAdapter {
  return new JsonLogAdapter({ id: 'logs', kind: 'jsonlog', path });
}

function line(over: Record<string, unknown> = {}): string {
  return JSON.stringify({ name: 'renovate', level: 20, msg: 'processing', v: 0, ...over });
}

const T = (m: number) => `2026-08-20T07:${String(m).padStart(2, '0')}:00.000Z`;

function header(minute = 0, version = '44.11.4'): string {
  return line({ msg: 'Renovate started', renovateVersion: version, time: T(minute) });
}

/** A realistic per-repo slice, with the branches line that carries updates. */
function repoRun(repo: string, from: number, withUpdate = false): string[] {
  const lines = [
    line({ repository: repo, time: T(from), msg: 'Repository started', renovateVersion: '44.11.4' }),
    line({ repository: repo, time: T(from + 1) }),
  ];
  if (withUpdate) {
    lines.push(
      line({
        repository: repo,
        time: T(from + 1),
        msg: 'branches info extended',
        branchesInformation: [
          {
            branchName: 'renovate/lodash-5.x',
            prNo: 7,
            upgrades: [
              { depName: 'lodash', updateType: 'major', currentValue: '4.17.21', newValue: '5.0.0', packageFile: 'package.json', datasource: 'npm' },
            ],
          },
        ],
      }),
    );
  }
  lines.push(
    line({ repository: repo, time: T(from + 2), msg: 'Repository finished', durationMs: 1000, status: 'activated' }),
  );
  return lines;
}

test('a multi-repo cron log yields a run per repository and updates from the newest', async () => {
  const root = dir();
  writeFileSync(
    join(root, 'renovate.log'),
    [header(), ...repoRun('acme/widget', 1, true), ...repoRun('acme/gadget', 5)].join('\n') + '\n',
  );

  const result = await adapter(root).collect();

  assert.deepEqual(result.warnings, []);
  assert.deepEqual(result.repos.map((r) => r.fullName).sort(), ['acme/gadget', 'acme/widget']);
  assert.equal(result.repos[0]?.installStatus, 'activated');
  assert.equal(result.runs.length, 2);
  assert.equal(result.runs[0]?.status, 'success');
  assert.equal(result.runs[0]?.runnerVersion, '44.11.4');
  assert.equal(result.updates.length, 1);
  assert.equal(result.updates[0]?.dependencyName, 'lodash');
  assert.equal(result.updates[0]?.state, 'pr-open');
});

test('one artifact file per run works, including in a subdirectory (CI shape)', async () => {
  const root = dir();
  mkdirSync(join(root, 'run-401'));
  writeFileSync(join(root, 'run-401', 'renovate.jsonl'), [header(), ...repoRun('acme/widget', 1)].join('\n'));
  writeFileSync(join(root, 'run-402.ndjson'), [header(10), ...repoRun('acme/widget', 11)].join('\n'));

  const result = await adapter(root).collect();

  assert.equal(result.repos.length, 1);
  assert.equal(result.runs.length, 2, 'each artifact is its own run');
  assert.deepEqual(
    result.runs.map((r) => r.startedAt).sort((a, b) => (a?.getTime() ?? 0) - (b?.getTime() ?? 0)),
    [new Date(T(1)), new Date(T(11))],
  );
});

test('a hand-copied duplicate of a live file does not double the runs', async () => {
  const root = dir();
  const text = [header(), ...repoRun('acme/widget', 1)].join('\n');
  writeFileSync(join(root, 'live.log'), text);
  writeFileSync(join(root, 'copy-for-safekeeping.log'), text);

  const result = await adapter(root).collect();
  assert.equal(result.runs.length, 1, 'the same run in two files is one run');
});

test('a malformed file costs a warning, never the other files', async () => {
  const root = dir();
  writeFileSync(join(root, 'good.log'), [header(), ...repoRun('acme/widget', 1)].join('\n'));
  writeFileSync(join(root, 'not-a-log.log'), 'plain text\nmore text\n');

  const result = await adapter(root).collect();

  assert.equal(result.runs.length, 1);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0] ?? '', /not-a-log\.log is not JSON Lines/);
});

test('a fatal line makes a failed run that carries the message', async () => {
  const root = dir();
  writeFileSync(
    join(root, 'renovate.log'),
    [
      header(),
      line({ repository: 'acme/widget', time: T(1) }),
      line({ repository: 'acme/widget', time: T(2), level: 60, msg: 'config is invalid' }),
    ].join('\n'),
  );

  const result = await adapter(root).collect();
  assert.equal(result.runs[0]?.status, 'failed');
  assert.equal(result.runs[0]?.error, 'config is invalid');
});

test('fetchLog streams exactly the run it is asked for', async () => {
  const root = dir();
  writeFileSync(
    join(root, 'renovate.log'),
    [header(), ...repoRun('acme/widget', 1), ...repoRun('acme/gadget', 5)].join('\n'),
  );

  const a = adapter(root);
  const { runs } = await a.collect();
  const gadget = runs.find((r) => r.repoId === 'logs:acme/gadget');
  assert.ok(gadget);

  const stream = await a.fetchLog(gadget);
  const text = await new Response(stream).text();
  assert.ok(text.includes('acme/gadget'));
  assert.ok(!text.includes('acme/widget'), 'the other run leaked into the slice');
});

test('fetchLog for a run whose file is gone throws a named error', async () => {
  const root = dir();
  writeFileSync(join(root, 'renovate.log'), [header(), ...repoRun('acme/widget', 1)].join('\n'));
  const a = adapter(root);
  const { runs } = await a.collect();
  rmSync(join(root, 'renovate.log'));

  await assert.rejects(a.fetchLog(runs[0]!), /no longer in/);
});

test('a new file is picked up on the next collect, no restart involved', async () => {
  const root = dir();
  writeFileSync(join(root, 'first.log'), [header(), ...repoRun('acme/widget', 1)].join('\n'));
  const a = adapter(root);
  assert.equal((await a.collect()).runs.length, 1);

  writeFileSync(join(root, 'second.log'), [header(10), ...repoRun('acme/gadget', 11)].join('\n'));
  const again = await a.collect();
  assert.equal(again.runs.length, 2);
  assert.deepEqual(again.repos.map((r) => r.fullName).sort(), ['acme/gadget', 'acme/widget']);
});

test('an appended invocation is picked up as a second run of the same repository', async () => {
  const root = dir();
  const file = join(root, 'renovate.log');
  writeFileSync(file, [header(), ...repoRun('acme/widget', 1)].join('\n') + '\n');
  const a = adapter(root);
  assert.equal((await a.collect()).runs.length, 1);

  // The runner appends its next invocation to the same file (Docker cron with
  // a stable RENOVATE_LOG_FILE).
  writeFileSync(file, [header(10), ...repoRun('acme/widget', 11)].join('\n'), { flag: 'a' });
  assert.equal((await a.collect()).runs.length, 2);
});

test('preflight names the path when the directory is missing', async () => {
  const result = await adapter('/does/not/exist').preflight();
  assert.equal(result.ok, false);
  assert.equal(result.problems[0]?.setting, 'sources[].path');
  assert.equal(result.problems[0]?.fatal, true);
  assert.match(result.problems[0]?.detail ?? '', /\/does\/not\/exist/);
});

test('preflight reports an empty directory as reachable but empty', async () => {
  const result = await adapter(dir()).preflight();
  assert.equal(result.ok, true);
  assert.equal(result.reachableButEmpty, true);
  assert.match(result.problems[0]?.detail ?? '', /RENOVATE_LOG_FILE/);
});
