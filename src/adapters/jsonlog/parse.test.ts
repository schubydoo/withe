import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseLogFile } from './parse.ts';

/** One bunyan-shaped line, the way the runner writes them. */
function line(over: Record<string, unknown> = {}): string {
  return JSON.stringify({ name: 'renovate', level: 20, msg: 'processing', v: 0, ...over });
}

const T = (m: number) => `2026-08-20T07:${String(m).padStart(2, '0')}:00.000Z`;

/** The header every runner shape writes once per start. */
function header(version = '44.11.4', minute = 0): string {
  return line({ msg: 'Renovate started', renovateVersion: version, time: T(minute) });
}

function repoLines(repo: string, from: number, to: number, over: Record<string, unknown> = {}): string[] {
  const out: string[] = [];
  for (let m = from; m <= to; m += 1) out.push(line({ repository: repo, time: T(m), ...over }));
  return out;
}

/** The finish line: the field pair every completed run ends with. */
function finish(repo: string, minute: number, status = 'activated'): string {
  return line({ repository: repo, time: T(minute), msg: 'Repository finished', durationMs: 1000, status });
}

test('a multi-repo invocation yields one run per repository (Docker cron shape)', () => {
  const text = [
    header(),
    ...repoLines('acme/widget', 1, 2),
    finish('acme/widget', 3),
    ...repoLines('acme/gadget', 4, 5),
    finish('acme/gadget', 6),
  ].join('\n');

  const { runs, malformedLines } = parseLogFile(text);
  assert.equal(malformedLines, 0);
  assert.deepEqual(runs.map((r) => r.repository), ['acme/widget', 'acme/gadget']);
  const [widget] = runs;
  assert.deepEqual(widget?.startedAt, new Date(T(1)));
  assert.deepEqual(widget?.completedAt, new Date(T(3)));
  assert.equal(widget?.status, 'success');
  assert.equal(widget?.runnerVersion, '44.11.4');
});

test('two appended invocations yield two runs of the same repository (hand-copied shape)', () => {
  const text = [
    header('44.11.4', 0),
    ...repoLines('acme/widget', 1, 1),
    finish('acme/widget', 2),
    header('44.12.0', 10),
    ...repoLines('acme/widget', 11, 11),
    finish('acme/widget', 12),
  ].join('\n');

  const { runs } = parseLogFile(text);
  assert.equal(runs.length, 2);
  assert.deepEqual(runs.map((r) => r.runnerVersion), ['44.11.4', '44.12.0']);
  assert.deepEqual(runs.map((r) => r.startedAt), [new Date(T(1)), new Date(T(11))]);
});

test('a file with no header still forms one invocation (truncated CI artifact)', () => {
  const text = [...repoLines('acme/widget', 1, 2), finish('acme/widget', 3)].join('\n');
  const { runs } = parseLogFile(text);
  assert.equal(runs.length, 1);
  assert.equal(runs[0]?.repository, 'acme/widget');
  assert.equal(runs[0]?.status, 'success');
  assert.equal(runs[0]?.runnerVersion, null);
});

test('a slice with no finish line is unknown, never a guessed success', () => {
  // The runner is mid-write, or the copy was truncated. Persisting this as a
  // completed success would stamp a completion instant the log never stated.
  const text = [header(), ...repoLines('acme/widget', 1, 2)].join('\n');
  const { runs } = parseLogFile(text);
  assert.equal(runs[0]?.status, 'unknown');
  assert.equal(runs[0]?.completedAt, null);
  assert.deepEqual(runs[0]?.startedAt, new Date(T(1)));
});

test('a URL in the repository field is a lookup, not a repository', () => {
  const text = [
    header(),
    ...repoLines('acme/widget', 1, 1),
    line({ repository: 'https://github.com/other/thing', time: T(2) }),
    finish('acme/widget', 3),
  ].join('\n');

  const { runs } = parseLogFile(text);
  assert.deepEqual(runs.map((r) => r.repository), ['acme/widget']);
  // The lookup line sits inside the slice, so a streamed log keeps its context.
  assert.equal(runs[0]?.lines.length, 3);
});

test("the finish line's own status word decides failure, and level 50 supplies the message", () => {
  const text = [
    header(),
    ...repoLines('acme/widget', 1, 1),
    line({ repository: 'acme/widget', time: T(2), level: 50, msg: 'Repository has unresolved errors' }),
    finish('acme/widget', 3, 'unknown-error'),
  ].join('\n');

  const { runs } = parseLogFile(text);
  assert.equal(runs[0]?.status, 'failed');
  assert.equal(runs[0]?.error, 'Repository has unresolved errors');
  assert.equal(runs[0]?.installStatus, null, 'an error word is an outcome, not an install state');
});

test('an error-level line alone does not fail a run the finish line calls healthy', () => {
  // The runner logs level 50 for a lookup that failed without failing the
  // repository; the finish line is the authority on the outcome.
  const text = [
    header(),
    ...repoLines('acme/widget', 1, 1),
    line({ repository: 'acme/widget', time: T(2), level: 50, msg: 'lookup failed for one datasource' }),
    finish('acme/widget', 3),
  ].join('\n');

  const { runs } = parseLogFile(text);
  assert.equal(runs[0]?.status, 'success');
  assert.equal(runs[0]?.error, null);
});

test('a GitLab subgroup path is a repository, not noise', () => {
  const text = [header(), ...repoLines('group/subgroup/project', 1, 1), finish('group/subgroup/project', 2)].join('\n');
  const { runs } = parseLogFile(text);
  assert.deepEqual(runs.map((r) => r.repository), ['group/subgroup/project']);
  assert.equal(runs[0]?.status, 'success');
});

test('a fatal line fails the run even with no finish line — the process died', () => {
  const text = [
    header(),
    ...repoLines('acme/widget', 1, 1),
    line({ repository: 'acme/widget', time: T(2), level: 60, msg: 'fatal: out of disk' }),
    ...repoLines('acme/gadget', 3, 3),
    finish('acme/gadget', 4),
  ].join('\n');

  const { runs } = parseLogFile(text);
  const widget = runs.find((r) => r.repository === 'acme/widget');
  const gadget = runs.find((r) => r.repository === 'acme/gadget');
  assert.equal(widget?.status, 'failed');
  assert.equal(widget?.error, 'fatal: out of disk');
  assert.equal(gadget?.status, 'success');
  assert.equal(gadget?.error, null);
});

test('the finish line names the install status, by fields not message text', () => {
  const text = [
    header(),
    ...repoLines('acme/widget', 1, 1),
    line({ repository: 'acme/widget', time: T(2), msg: 'Repository finished', durationMs: 21_698, status: 'activated' }),
  ].join('\n');

  const { runs } = parseLogFile(text);
  assert.equal(runs[0]?.installStatus, 'activated');
  assert.equal(runs[0]?.status, 'success');
});

test('non-JSON lines are counted, never fatal, and blanks count for neither side', () => {
  const text = [
    'not json at all',
    '',
    header(),
    ...repoLines('acme/widget', 1, 1),
    finish('acme/widget', 2),
    '{truncated',
  ].join('\n');

  const { runs, malformedLines, contentLines, totalLines } = parseLogFile(text);
  assert.equal(runs.length, 1);
  assert.equal(malformedLines, 2);
  assert.equal(contentLines, 5, 'the blank line is not content');
  assert.equal(totalLines, 6);
});

test('line numbers address the slice in the original file', () => {
  const text = [
    header(),                                   // line 1
    line({ msg: 'global config', time: T(0) }), // line 2
    ...repoLines('acme/widget', 1, 2),          // lines 3-4
    finish('acme/widget', 3),                   // line 5
  ].join('\n');

  const { runs } = parseLogFile(text);
  assert.equal(runs[0]?.firstLine, 3);
  assert.equal(runs[0]?.lastLine, 5);
});

test('an array line is not an entry, and a line missing every optional field parses', () => {
  const text = [
    header(),
    JSON.stringify(['not', 'an', 'object']),          // an array: typeof object, but not an entry
    JSON.stringify({ repository: 'acme/widget' }),     // no time, level, or msg
    finish('acme/widget', 2),
  ].join('\n');

  const { runs, malformedLines } = parseLogFile(text);
  assert.equal(malformedLines, 1, 'the array line is counted, not an entry');
  assert.equal(runs.length, 1);
  assert.equal(runs[0]?.repository, 'acme/widget');
  assert.equal(runs[0]?.status, 'success');
});

test('a slice with no timestamps reports null start and completion', () => {
  // No `time` on any line and no finish line: the run is unknown, with null
  // start and completion rather than a guessed instant.
  const text = [
    line({ msg: 'Renovate started', renovateVersion: '44.11.4' }),
    line({ repository: 'acme/widget' }),
  ].join('\n');

  const { runs } = parseLogFile(text);
  assert.equal(runs.length, 1);
  assert.equal(runs[0]?.status, 'unknown');
  assert.equal(runs[0]?.startedAt, null);
  assert.equal(runs[0]?.completedAt, null);
});
